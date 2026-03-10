import type { Readable } from 'node:stream'

import type { Logger } from '../infra/log/types'

import type { WaMediaCrypto } from './WaMediaCrypto'

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'
export type MediaCryptoType = MediaKind | 'ptt' | 'gif' | 'ptv' | 'history' | 'md-app-state'

export interface MediaUpload {
    readonly kind: MediaKind
    readonly mimetype: string
    readonly data: Uint8Array
    readonly fileName?: string
    readonly caption?: string
}

export interface MediaDownload {
    readonly directPath: string
    readonly mediaKey: Uint8Array
    readonly fileSha256: Uint8Array
    readonly fileEncSha256?: Uint8Array
    readonly type?: MediaCryptoType
}

export interface WaStreamTransferRequestBase {
    readonly url?: string
    readonly directPath?: string
    readonly hosts?: readonly string[]
    readonly headers?: Readonly<Record<string, string>>
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
}

export interface WaStreamDownloadRequest extends WaStreamTransferRequestBase {}

export interface WaStreamUploadRequest extends WaStreamTransferRequestBase {
    readonly method?: 'POST' | 'PUT'
    readonly body: Uint8Array | Readable
    readonly contentLength?: number
    readonly contentType?: string
}

export interface WaStreamTransferResponse {
    readonly url: string
    readonly status: number
    readonly ok: boolean
    readonly headers: Readonly<Record<string, string>>
    readonly body: Readable | null
}

export interface WaEncryptedUploadRequest extends WaStreamTransferRequestBase {
    readonly mediaType: MediaCryptoType
    readonly method?: 'POST' | 'PUT'
    readonly plaintext: Uint8Array | Readable
    readonly mediaKey?: Uint8Array
    readonly contentLength?: number
    readonly contentType?: string
}

export interface WaEncryptedUploadResult {
    readonly transfer: WaStreamTransferResponse
    readonly mediaKey: Uint8Array
    readonly fileSha256: Uint8Array
    readonly fileEncSha256: Uint8Array
}

export interface WaEncryptedDownloadRequest extends WaStreamDownloadRequest {
    readonly mediaType: MediaCryptoType
    readonly mediaKey: Uint8Array
    readonly fileSha256?: Uint8Array
    readonly fileEncSha256?: Uint8Array
}

export interface WaEncryptedDownloadStream {
    readonly plaintext: Readable
    readonly metadata: Promise<{
        readonly fileSha256: Uint8Array
        readonly fileEncSha256: Uint8Array
    }>
}

export interface WaAbortContext {
    readonly signal: AbortSignal
    cleanup(): void
}

export interface WaMediaTransferClientOptions {
    readonly logger?: Logger
    readonly defaultHosts?: readonly string[]
    readonly defaultTimeoutMs?: number
    readonly defaultHeaders?: Readonly<Record<string, string>>
    readonly mediaCrypto?: WaMediaCrypto
}

export interface WaMediaDerivedKeys {
    readonly iv: Uint8Array
    readonly encKey: Uint8Array
    readonly macKey: Uint8Array
    readonly refKey: Uint8Array
}

export interface WaMediaEncryptionResult {
    readonly ciphertextHmac: Uint8Array
    readonly fileSha256: Uint8Array
    readonly fileEncSha256: Uint8Array
}

export interface WaMediaDecryptionResult {
    readonly plaintext: Uint8Array
    readonly fileSha256: Uint8Array
    readonly fileEncSha256: Uint8Array
}

export interface WaMediaReadableEncryptionResult {
    readonly encrypted: Readable
    readonly metadata: Promise<{
        readonly fileSha256: Uint8Array
        readonly fileEncSha256: Uint8Array
    }>
}

export interface WaMediaReadableDecryptionResult {
    readonly plaintext: Readable
    readonly metadata: Promise<{
        readonly fileSha256: Uint8Array
        readonly fileEncSha256: Uint8Array
    }>
}

export interface WaMediaDecryptReadableOptions {
    readonly mediaType: MediaCryptoType
    readonly mediaKey: Uint8Array
    readonly expectedFileSha256?: Uint8Array
    readonly expectedFileEncSha256?: Uint8Array
}
