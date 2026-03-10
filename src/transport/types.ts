import type { SignalKeyPair } from '../auth/types'

import type { WaLoginPayloadConfig, WaRegistrationPayloadConfig } from './noise/types'

export type BinaryAttrs = Readonly<Record<string, string>>

export interface BinaryNode {
    readonly tag: string
    readonly attrs: BinaryAttrs
    readonly content?: Uint8Array | string | readonly BinaryNode[]
}

export interface SocketOpenInfo {
    readonly openedAt: number
}

export interface SocketCloseInfo {
    readonly code: number
    readonly reason: string
    readonly wasClean: boolean
}

export interface WaSocketConfig {
    readonly url?: string
    readonly urls?: readonly string[]
    readonly protocols?: readonly string[]
    readonly headers?: Readonly<Record<string, string>>
    readonly timeoutIntervalMs?: number
}

export interface WaSocketHandlers {
    readonly onOpen?: (info: SocketOpenInfo) => void | Promise<void>
    readonly onClose?: (info: SocketCloseInfo) => void | Promise<void>
    readonly onError?: (error: Error) => void | Promise<void>
    readonly onMessage?: (payload: Uint8Array) => void | Promise<void>
}

export type WaStanzaHandler = (payload: Uint8Array) => void | Promise<void>
export type WaInflateFrame = (compressed: Uint8Array) => Uint8Array | Promise<Uint8Array>
export type WaNoisePayloadProvider = Uint8Array | (() => Uint8Array | Promise<Uint8Array>)

export interface WaCommsConfig extends WaSocketConfig {
    readonly connectTimeoutMs?: number
    readonly reconnectIntervalMs?: number
    readonly maxReconnectAttempts?: number
    readonly noise: WaNoiseConfig
}

export interface WaCommsState {
    readonly started: boolean
    readonly connected: boolean
    readonly handlingRequests: boolean
    readonly reconnectAttempts: number
}

export interface NoiseKeyMaterial {
    readonly clientEphemeral: Uint8Array
    readonly clientStatic: Uint8Array
    readonly serverStatic?: Uint8Array
}

export interface NoiseState {
    readonly handshakeHash: Uint8Array
    readonly chainingKey: Uint8Array
    readonly writeKey?: Uint8Array
    readonly readKey?: Uint8Array
}

export interface WaNoiseConfig {
    readonly clientStaticKeyPair: SignalKeyPair
    readonly isRegistered: boolean
    readonly loginPayload?: WaNoisePayloadProvider
    readonly registrationPayload?: WaNoisePayloadProvider
    readonly loginPayloadConfig?: WaLoginPayloadConfig
    readonly registrationPayloadConfig?: WaRegistrationPayloadConfig
    readonly serverStaticKey?: Uint8Array
    readonly routingInfo?: Uint8Array
    readonly protocolHeader?: Uint8Array
    readonly verifyCertificateChain?: boolean
}

export interface WebSocketEventLike {
    readonly code?: number
    readonly reason?: string
    readonly wasClean?: boolean
    readonly data?: unknown
}

export interface RawWebSocket {
    binaryType: string
    readyState: number
    onopen: ((event: WebSocketEventLike) => void) | null
    onclose: ((event: WebSocketEventLike) => void) | null
    onerror: ((event: WebSocketEventLike) => void) | null
    onmessage: ((event: WebSocketEventLike) => void) | null
    close(code?: number, reason?: string): void
    send(data: string | ArrayBuffer | Uint8Array): void
}

export type RawWebSocketConstructor = new (
    url: string,
    protocols?: string | readonly string[],
    options?: { headers?: Readonly<Record<string, string>> }
) => RawWebSocket

export interface ConnectionWaiter {
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    readonly timer: NodeJS.Timeout
}

export interface PendingSocket {
    readonly url: string
    readonly socket: RawWebSocket
    timer: NodeJS.Timeout | null
    settled: boolean
}
