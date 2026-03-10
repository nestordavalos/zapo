import { Readable } from 'node:stream'

import type { Logger } from '../infra/log/types'
import { toBytesView } from '../util/bytes'
import { toError } from '../util/errors'

import { DEFAULT_MEDIA_HOSTS, DEFAULT_TIMEOUT_MS } from './constants'
import type {
    WaAbortContext,
    WaEncryptedDownloadStream,
    WaEncryptedDownloadRequest,
    WaEncryptedUploadRequest,
    WaEncryptedUploadResult,
    WaMediaCryptoLike,
    WaMediaTransferClientOptions,
    WaStreamDownloadRequest,
    WaStreamTransferResponse,
    WaStreamUploadRequest
} from './types'
import { WaMediaCrypto } from './WaMediaCrypto'

const EMPTY_BYTES = new Uint8Array(0)
const TEXT_ENCODER = new TextEncoder()

export class WaMediaTransferClient {
    private readonly logger?: Logger
    private readonly defaultHosts: readonly string[]
    private readonly defaultTimeoutMs: number
    private readonly defaultHeaders: Readonly<Record<string, string>>
    private readonly mediaCrypto: WaMediaCryptoLike

    public constructor(options: WaMediaTransferClientOptions = {}) {
        this.logger = options.logger
        this.defaultHosts = options.defaultHosts ?? DEFAULT_MEDIA_HOSTS
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
        this.defaultHeaders = options.defaultHeaders ?? {}
        this.mediaCrypto = options.mediaCrypto ?? new WaMediaCrypto()
    }

    public async downloadStream(
        request: WaStreamDownloadRequest
    ): Promise<WaStreamTransferResponse> {
        const urls = this.resolveUrls(request.url, request.directPath, request.hosts)
        const headers = this.mergeHeaders(request.headers)
        const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
        this.logger?.debug('media download stream start', {
            urls: urls.length,
            timeoutMs
        })
        const result = await this.fetchWithFallback(
            urls,
            timeoutMs,
            request.signal,
            (url, signal) =>
                fetch(url, {
                    method: 'GET',
                    headers,
                    signal
                })
        )
        this.logger?.trace('media download stream response', {
            url: result.url,
            status: result.response.status
        })
        return this.toResponse(result.url, result.response)
    }

    public async downloadBytes(request: WaStreamDownloadRequest): Promise<Uint8Array> {
        const response = await this.downloadStream(request)
        if (!response.ok) {
            await this.drainBody(response.body)
            throw new Error(`download failed with status ${response.status} for ${response.url}`)
        }
        if (!response.body) {
            return EMPTY_BYTES
        }
        return this.readAll(response.body)
    }

    public async uploadStream(request: WaStreamUploadRequest): Promise<WaStreamTransferResponse> {
        const bodyIsBytes = request.body instanceof Uint8Array
        const urls = this.resolveUrls(request.url, request.directPath, request.hosts)
        const uploadUrls = bodyIsBytes ? urls : urls.slice(0, 1)
        if (!bodyIsBytes && urls.length > 1) {
            this.logger?.warn('upload stream fallback disabled for non-replayable body', {
                attemptedHosts: urls.length
            })
        }

        const headers = this.mergeHeaders(request.headers)
        if (request.contentType) {
            headers['content-type'] = request.contentType
        }
        if (request.contentLength !== null && request.contentLength !== undefined) {
            headers['content-length'] = String(request.contentLength)
        }

        const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
        const method = request.method ?? 'POST'
        this.logger?.debug('media upload stream start', {
            urls: uploadUrls.length,
            timeoutMs,
            method
        })
        const result = await this.fetchWithFallback(
            uploadUrls,
            timeoutMs,
            request.signal,
            async (url, signal) => {
                if (bodyIsBytes) {
                    return fetch(url, {
                        method,
                        headers,
                        signal,
                        body: request.body
                    })
                }

                return fetch(url, {
                    method,
                    headers,
                    signal,
                    body: request.body as unknown as never,
                    duplex: 'half'
                } as RequestInit)
            }
        )
        this.logger?.trace('media upload stream response', {
            url: result.url,
            status: result.response.status
        })
        return this.toResponse(result.url, result.response)
    }

    public async uploadEncrypted(
        request: WaEncryptedUploadRequest
    ): Promise<WaEncryptedUploadResult> {
        this.logger?.info('media encrypted upload start', {
            mediaType: request.mediaType
        })
        const mediaKey = request.mediaKey ?? (await this.mediaCrypto.generateMediaKey())
        if (request.plaintext instanceof Uint8Array) {
            const encrypted = await this.mediaCrypto.encryptBytes(
                request.mediaType,
                mediaKey,
                request.plaintext
            )
            const transfer = await this.uploadStream({
                url: request.url,
                directPath: request.directPath,
                hosts: request.hosts,
                headers: request.headers,
                timeoutMs: request.timeoutMs,
                signal: request.signal,
                method: request.method,
                body: encrypted.ciphertextHmac,
                contentLength: encrypted.ciphertextHmac.byteLength,
                contentType: request.contentType
            })
            return {
                transfer,
                mediaKey,
                fileSha256: encrypted.fileSha256,
                fileEncSha256: encrypted.fileEncSha256
            }
        }

        const prepared = await this.mediaCrypto.encryptReadable(
            request.mediaType,
            mediaKey,
            request.plaintext
        )
        const encryptedLength =
            request.contentLength !== null && request.contentLength !== undefined
                ? this.mediaCrypto.encryptedLength(request.contentLength)
                : undefined

        let transfer: WaStreamTransferResponse
        try {
            transfer = await this.uploadStream({
                url: request.url,
                directPath: request.directPath,
                hosts: request.hosts,
                headers: request.headers,
                timeoutMs: request.timeoutMs,
                signal: request.signal,
                method: request.method,
                body: prepared.encrypted,
                contentLength: encryptedLength,
                contentType: request.contentType
            })
        } catch (error) {
            prepared.encrypted.destroy(toError(error))
            await prepared.metadata.catch(() => undefined)
            throw error
        }

        const metadata = await prepared.metadata
        this.logger?.info('media encrypted upload completed', {
            status: transfer.status
        })
        return {
            transfer,
            mediaKey,
            fileSha256: metadata.fileSha256,
            fileEncSha256: metadata.fileEncSha256
        }
    }

    public async downloadAndDecrypt(request: WaEncryptedDownloadRequest): Promise<Uint8Array> {
        this.logger?.info('media encrypted download start', {
            mediaType: request.mediaType
        })
        const decrypted = await this.downloadAndDecryptStream(request)
        try {
            const plaintext = await this.readAll(decrypted.plaintext)
            await decrypted.metadata
            this.logger?.info('media encrypted download completed', {
                byteLength: plaintext.byteLength
            })
            return plaintext
        } catch (error) {
            decrypted.plaintext.destroy(toError(error))
            throw error
        }
    }

    public async downloadAndDecryptStream(
        request: WaEncryptedDownloadRequest
    ): Promise<WaEncryptedDownloadStream> {
        const response = await this.downloadStream(request)
        if (!response.ok) {
            await this.drainBody(response.body)
            throw new Error(`download failed with status ${response.status} for ${response.url}`)
        }
        if (!response.body) {
            throw new Error(`download response body is empty for ${response.url}`)
        }

        const decrypted = await this.mediaCrypto.decryptReadable(response.body, {
            mediaType: request.mediaType,
            mediaKey: request.mediaKey,
            expectedFileSha256: request.fileSha256,
            expectedFileEncSha256: request.fileEncSha256
        })
        decrypted.metadata.catch(() => undefined)
        this.logger?.debug('media encrypted download stream ready', {
            mediaType: request.mediaType
        })
        return {
            plaintext: decrypted.plaintext,
            metadata: decrypted.metadata
        }
    }

    public async readResponseBytes(response: WaStreamTransferResponse): Promise<Uint8Array> {
        if (!response.body) {
            return EMPTY_BYTES
        }
        return this.readAll(response.body)
    }

    private resolveUrls(
        url: string | undefined,
        directPath: string | undefined,
        hosts: readonly string[] | undefined
    ): readonly string[] {
        const resolved: string[] = []
        if (url) {
            resolved.push(url)
        }
        if (directPath) {
            if (directPath.startsWith('https://') || directPath.startsWith('http://')) {
                resolved.push(directPath)
            } else {
                const normalizedPath = directPath.startsWith('/') ? directPath : `/${directPath}`
                for (const host of hosts ?? this.defaultHosts) {
                    resolved.push(`https://${host}${normalizedPath}`)
                }
            }
        }
        if (resolved.length === 0) {
            throw new Error('missing transfer url/directPath')
        }

        return this.unique(resolved)
    }

    private mergeHeaders(
        headers: Readonly<Record<string, string>> | undefined
    ): Record<string, string> {
        const merged: Record<string, string> = {}
        for (const [key, value] of Object.entries(this.defaultHeaders)) {
            merged[key.toLowerCase()] = value
        }
        for (const [key, value] of Object.entries(headers ?? {})) {
            merged[key.toLowerCase()] = value
        }
        return merged
    }

    private async fetchWithFallback(
        urls: readonly string[],
        timeoutMs: number,
        signal: AbortSignal | undefined,
        send: (url: string, signal: AbortSignal) => Promise<Response>
    ): Promise<{ readonly url: string; readonly response: Response }> {
        let lastError: Error | null = null

        for (let index = 0; index < urls.length; index += 1) {
            const url = urls[index]
            const abort = this.createAbortContext(timeoutMs, signal)
            try {
                const response = await send(url, abort.signal)
                const shouldFallback = response.status >= 500 && index < urls.length - 1
                if (!shouldFallback) {
                    return { url, response }
                }
                await this.cancelWebBody(response.body)
                this.logger?.warn('transfer fallback to next host', {
                    url,
                    status: response.status
                })
            } catch (error) {
                const normalized = toError(error)
                lastError = normalized
                if (abort.signal.aborted && signal?.aborted) {
                    throw normalized
                }
                if (index === urls.length - 1) {
                    throw normalized
                }
                this.logger?.warn('transfer host failed, trying next host', {
                    url,
                    message: normalized.message
                })
            } finally {
                abort.cleanup()
            }
        }

        throw lastError ?? new Error('transfer failed')
    }

    private createAbortContext(
        timeoutMs: number,
        externalSignal: AbortSignal | undefined
    ): WaAbortContext {
        const controller = new AbortController()
        const timer = setTimeout(() => {
            controller.abort(new Error(`transfer timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()

        let onExternalAbort: (() => void) | null = null
        if (externalSignal) {
            onExternalAbort = () => controller.abort(externalSignal.reason)
            if (externalSignal.aborted) {
                onExternalAbort()
            } else {
                externalSignal.addEventListener('abort', onExternalAbort, { once: true })
            }
        }

        return {
            signal: controller.signal,
            cleanup: () => {
                clearTimeout(timer)
                if (externalSignal && onExternalAbort) {
                    externalSignal.removeEventListener('abort', onExternalAbort)
                }
            }
        }
    }

    private toResponse(url: string, response: Response): WaStreamTransferResponse {
        return {
            url,
            status: response.status,
            ok: response.ok,
            headers: this.headersToRecord(response.headers),
            body: response.body
                ? Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>)
                : null
        }
    }

    private headersToRecord(headers: Headers): Readonly<Record<string, string>> {
        const output: Record<string, string> = {}
        for (const [key, value] of headers.entries()) {
            output[key] = value
        }
        return output
    }

    private async cancelWebBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
        if (!body) {
            return
        }
        try {
            await body.cancel()
        } catch {
            // ignore cancel errors from remote resets
        }
    }

    private async drainBody(body: Readable | null): Promise<void> {
        if (!body) {
            return
        }
        try {
            for await (const chunk of body) {
                void chunk
            }
        } catch {
            // ignore drain errors
        }
    }

    private async readAll(body: Readable): Promise<Uint8Array> {
        const chunks: Uint8Array[] = []
        let total = 0
        for await (const chunk of body) {
            const bytes = this.toBytes(chunk)
            chunks.push(bytes)
            total += bytes.byteLength
        }

        if (total === 0) {
            return EMPTY_BYTES
        }
        if (chunks.length === 1) {
            return chunks[0]
        }
        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
            merged.set(chunk, offset)
            offset += chunk.byteLength
        }
        this.logger?.trace('media readAll merged chunks', { total, chunks: chunks.length })
        return merged
    }

    private toBytes(chunk: unknown): Uint8Array {
        if (chunk instanceof Uint8Array) {
            return chunk
        }
        if (typeof chunk === 'string') {
            return TEXT_ENCODER.encode(chunk)
        }
        if (chunk instanceof ArrayBuffer) {
            return toBytesView(chunk)
        }
        throw new Error(`unsupported stream chunk type: ${typeof chunk}`)
    }

    private unique(values: readonly string[]): readonly string[] {
        const set = new Set(values)
        return Array.from(set)
    }
}
