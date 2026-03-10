import { ConsoleLogger } from '../infra/log/Logger'
import type { Logger } from '../infra/log/types'
import { toBytesView } from '../util/bytes'
import { toError } from '../util/errors'

import {
    DEFAULT_CHAT_SOCKET_URLS,
    READY_STATE_CLOSED,
    READY_STATE_CONNECTING,
    READY_STATE_OPEN
} from './constants'
import type {
    RawWebSocket,
    RawWebSocketConstructor,
    PendingSocket,
    SocketCloseInfo,
    SocketOpenInfo,
    WebSocketEventLike,
    WaSocketConfig,
    WaSocketHandlers
} from './types'

const TEXT_ENCODER = new TextEncoder()

function resolveWebSocketConstructor(): RawWebSocketConstructor {
    const ctor = (globalThis as typeof globalThis & { WebSocket?: RawWebSocketConstructor })
        .WebSocket
    if (!ctor) {
        throw new Error('global WebSocket is not available in this runtime')
    }
    return ctor
}

function resolveSocketUrls(config: WaSocketConfig): readonly string[] {
    const preferredUrls = config.urls
    if (preferredUrls && preferredUrls.length > 0) {
        return Object.freeze(Array.from(new Set(preferredUrls)))
    }
    if (config.url) {
        return Object.freeze([config.url])
    }
    return DEFAULT_CHAT_SOCKET_URLS
}

export class WaWebSocket {
    private readonly config: Readonly<
        Required<Pick<WaSocketConfig, 'timeoutIntervalMs'>> &
            Omit<WaSocketConfig, 'timeoutIntervalMs'>
    >
    private readonly socketUrls: readonly string[]
    private readonly logger: Logger
    private readonly webSocketCtor: RawWebSocketConstructor
    private readonly connectingSockets: Set<RawWebSocket>
    private handlers: WaSocketHandlers
    private socket: RawWebSocket | null
    private closeWaiter: ((info: SocketCloseInfo) => void) | null

    public constructor(config: WaSocketConfig, logger: Logger = new ConsoleLogger('info')) {
        this.config = Object.freeze({
            ...config,
            timeoutIntervalMs: config.timeoutIntervalMs ?? 10_000
        })
        this.socketUrls = resolveSocketUrls(config)
        this.logger = logger
        this.webSocketCtor = resolveWebSocketConstructor()
        this.connectingSockets = new Set<RawWebSocket>()
        this.handlers = {}
        this.socket = null
        this.closeWaiter = null
    }

    public setHandlers(handlers: WaSocketHandlers): void {
        this.handlers = handlers
    }

    public isOpen(): boolean {
        return this.socket?.readyState === READY_STATE_OPEN
    }

    public isConnecting(): boolean {
        return this.socket?.readyState === READY_STATE_CONNECTING || this.connectingSockets.size > 0
    }

    public getReadyState(): number {
        if (this.connectingSockets.size > 0) {
            return READY_STATE_CONNECTING
        }
        return this.socket?.readyState ?? READY_STATE_CLOSED
    }

    public async open(): Promise<SocketOpenInfo> {
        if (this.isOpen()) {
            this.logger.trace('socket open skipped: already open')
            return { openedAt: Date.now() }
        }
        if (this.isConnecting()) {
            throw new Error('websocket is already connecting')
        }
        this.logger.info('socket open start', { urls: this.socketUrls.length })

        if (this.socketUrls.length === 1) {
            return this.openSingle(this.socketUrls[0])
        }
        return this.openConcurrently(this.socketUrls)
    }

    public async close(code = 1000, reason = ''): Promise<SocketCloseInfo | null> {
        this.logger.debug('socket close requested', { code, reason })
        const socket = this.socket
        if (!socket) {
            if (this.connectingSockets.size > 0) {
                for (const connectingSocket of this.connectingSockets) {
                    this.closeSocketSafe(connectingSocket, code, reason)
                }
                this.connectingSockets.clear()
                return {
                    code,
                    reason,
                    wasClean: true
                }
            }
            return null
        }
        if (socket.readyState === READY_STATE_CLOSED) {
            this.socket = null
            return {
                code,
                reason,
                wasClean: true
            }
        }

        return new Promise<SocketCloseInfo>((resolve) => {
            const timer = setTimeout(() => {
                if (this.closeWaiter) {
                    this.closeWaiter = null
                    if (this.socket === socket) {
                        this.socket = null
                    }
                    resolve({
                        code,
                        reason,
                        wasClean: false
                    })
                }
            }, this.config.timeoutIntervalMs)

            this.closeWaiter = (info) => {
                clearTimeout(timer)
                if (this.socket === socket) {
                    this.socket = null
                }
                resolve(info)
            }

            try {
                socket.close(code, reason)
            } catch (error) {
                clearTimeout(timer)
                this.closeWaiter = null
                if (this.socket === socket) {
                    this.socket = null
                }
                resolve({
                    code,
                    reason,
                    wasClean: false
                })
                void this.handlers.onError?.(toError(error))
            }
        })
    }

    public async send(data: string | ArrayBuffer | Uint8Array): Promise<void> {
        const socket = this.socket
        if (!socket || socket.readyState !== READY_STATE_OPEN) {
            throw new Error('websocket is not connected')
        }
        this.logger.trace('socket send', {
            payloadType: typeof data === 'string' ? 'string' : 'binary'
        })
        socket.send(data)
    }

    private async openSingle(url: string): Promise<SocketOpenInfo> {
        const socket = this.createRawSocket(url)
        socket.binaryType = 'arraybuffer'
        this.connectingSockets.add(socket)

        return new Promise<SocketOpenInfo>((resolve, reject) => {
            let settled = false
            const fail = (error: Error): void => {
                if (settled) {
                    return
                }
                settled = true
                clearTimeout(timer)
                this.connectingSockets.delete(socket)
                if (this.socket === socket) {
                    this.socket = null
                }
                reject(error)
            }

            const timer = setTimeout(() => {
                this.logger.warn('socket connect timeout', { url })
                this.closeSocketSafe(socket, 4000, 'connect_timeout')
                fail(new Error(`websocket connect timeout for ${url}`))
            }, this.config.timeoutIntervalMs)

            socket.onopen = () => {
                if (settled) {
                    return
                }
                settled = true
                clearTimeout(timer)
                this.connectingSockets.delete(socket)
                this.socket = socket
                this.bindRuntimeHandlers(socket)
                this.logger.info('socket open success', { url })
                void this.handlers.onOpen?.({ openedAt: Date.now() })
                resolve({ openedAt: Date.now() })
            }

            socket.onerror = () => {
                this.logger.warn('socket open error', { url })
                fail(new Error(`websocket connect error for ${url}`))
            }

            socket.onclose = (event) => {
                const info = this.toCloseInfo(event)
                this.logger.warn('socket closed before open', {
                    url,
                    code: info.code,
                    reason: info.reason
                })
                fail(
                    new Error(
                        `websocket closed before open (${info.code}:${info.reason}) for ${url}`
                    )
                )
            }
        })
    }

    private async openConcurrently(urls: readonly string[]): Promise<SocketOpenInfo> {
        const pendingSockets: PendingSocket[] = urls.map((url) => {
            const socket = this.createRawSocket(url)
            socket.binaryType = 'arraybuffer'
            this.connectingSockets.add(socket)
            return {
                url,
                socket,
                timer: null,
                settled: false
            }
        })

        return new Promise<SocketOpenInfo>((resolve, reject) => {
            let done = false
            let failedCount = 0
            let lastError: Error | null = null

            const fail = (entry: PendingSocket, error: Error): void => {
                if (done || entry.settled) {
                    return
                }
                entry.settled = true
                if (entry.timer) {
                    clearTimeout(entry.timer)
                    entry.timer = null
                }
                this.connectingSockets.delete(entry.socket)
                failedCount += 1
                lastError = error
                if (failedCount === pendingSockets.length) {
                    done = true
                    reject(lastError ?? new Error('websocket connect error'))
                }
            }

            const win = (entry: PendingSocket): void => {
                if (entry.settled) {
                    return
                }
                entry.settled = true
                if (entry.timer) {
                    clearTimeout(entry.timer)
                    entry.timer = null
                }

                if (done) {
                    this.connectingSockets.delete(entry.socket)
                    this.closeSocketSafe(entry.socket, 1000, 'loser_socket')
                    return
                }

                done = true
                this.connectingSockets.delete(entry.socket)
                for (const other of pendingSockets) {
                    if (other.socket === entry.socket) {
                        continue
                    }
                    if (!other.settled) {
                        other.settled = true
                        if (other.timer) {
                            clearTimeout(other.timer)
                            other.timer = null
                        }
                    }
                    this.connectingSockets.delete(other.socket)
                    this.closeSocketSafe(other.socket, 1000, 'loser_socket')
                }

                this.socket = entry.socket
                this.bindRuntimeHandlers(entry.socket)
                this.logger.info('socket open success (race winner)', { url: entry.url })
                void this.handlers.onOpen?.({ openedAt: Date.now() })
                resolve({ openedAt: Date.now() })
            }

            for (const entry of pendingSockets) {
                entry.timer = setTimeout(() => {
                    this.logger.warn('socket connect timeout', { url: entry.url })
                    this.closeSocketSafe(entry.socket, 4000, 'connect_timeout')
                    fail(entry, new Error(`websocket connect timeout for ${entry.url}`))
                }, this.config.timeoutIntervalMs)

                entry.socket.onopen = () => {
                    win(entry)
                }
                entry.socket.onerror = () => {
                    this.logger.warn('socket open error', { url: entry.url })
                    fail(entry, new Error(`websocket connect error for ${entry.url}`))
                }
                entry.socket.onclose = (event) => {
                    const info = this.toCloseInfo(event)
                    this.logger.warn('socket closed before open', {
                        url: entry.url,
                        code: info.code,
                        reason: info.reason
                    })
                    fail(
                        entry,
                        new Error(
                            `websocket closed before open (${info.code}:${info.reason}) for ${entry.url}`
                        )
                    )
                }
            }
        })
    }

    private bindRuntimeHandlers(socket: RawWebSocket): void {
        socket.onmessage = (event) => {
            void this.handleMessage(event.data)
        }
        socket.onerror = (event) => {
            void event
            this.logger.warn('socket runtime error event')
            void this.handlers.onError?.(new Error('websocket runtime error'))
        }
        socket.onclose = (event) => {
            const info = this.toCloseInfo(event)
            this.logger.info('socket runtime closed', {
                code: info.code,
                reason: info.reason,
                wasClean: info.wasClean
            })
            if (this.socket === socket) {
                this.socket = null
            }
            const waiter = this.closeWaiter
            this.closeWaiter = null
            if (waiter) {
                waiter(info)
            }
            void this.handlers.onClose?.(info)
        }
    }

    private async handleMessage(data: unknown): Promise<void> {
        try {
            const payload = await this.normalizePayload(data)
            if (!payload) {
                this.logger.trace('socket message ignored: unsupported payload shape')
                return
            }
            this.logger.trace('socket message received', { byteLength: payload.byteLength })
            await this.handlers.onMessage?.(payload)
        } catch (error) {
            this.logger.error('socket message handling failed', {
                message: toError(error).message
            })
            void this.handlers.onError?.(toError(error))
        }
    }

    private async normalizePayload(data: unknown): Promise<Uint8Array | null> {
        if (data instanceof Uint8Array) {
            return data
        }
        if (data instanceof ArrayBuffer) {
            return toBytesView(data)
        }
        if (ArrayBuffer.isView(data)) {
            return toBytesView(data)
        }
        if (typeof data === 'string') {
            return TEXT_ENCODER.encode(data)
        }
        if (data && typeof data === 'object' && 'arrayBuffer' in data) {
            const maybeBlob = data as { arrayBuffer: () => Promise<ArrayBuffer> }
            const buffer = await maybeBlob.arrayBuffer()
            return toBytesView(buffer)
        }
        return null
    }

    private toCloseInfo(event: WebSocketEventLike): SocketCloseInfo {
        return {
            code: typeof event.code === 'number' ? event.code : 1000,
            reason: typeof event.reason === 'string' ? event.reason : '',
            wasClean: event.wasClean === true
        }
    }

    private closeSocketSafe(socket: RawWebSocket, code: number, reason: string): void {
        try {
            socket.close(code, reason)
        } catch {
            // no-op
        }
    }

    private createRawSocket(url: string): RawWebSocket {
        const ctor = this.webSocketCtor as unknown as {
            new (
                url: string,
                protocols?: string | readonly string[],
                options?: { headers?: Readonly<Record<string, string>> }
            ): RawWebSocket
        }
        const headers = this.config.headers
        if (headers && Object.keys(headers).length > 0) {
            return new ctor(url, this.config.protocols, { headers })
        }
        return new ctor(url, this.config.protocols)
    }
}
