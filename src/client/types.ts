import type { WaAuthSocketOptions } from '../auth/flow/types'
import type { WaAuthClientOptions, WaAuthCredentials } from '../auth/types'
import type { WaMessagePublishOptions } from '../message/types'
import type { BinaryNode } from '../transport/types'

export interface WaClientOptions extends WaAuthClientOptions, WaAuthSocketOptions {}

export interface WaSignalMessagePublishInput {
    readonly to: string
    readonly plaintext: Uint8Array
    readonly expectedIdentity?: Uint8Array
    readonly id?: string
    readonly type?: string
    readonly participant?: string
    readonly deviceFanout?: string
}

export interface WaSendMessageOptions extends WaMessagePublishOptions {
    readonly id?: string
    readonly expectedIdentity?: Uint8Array
}

export interface WaMediaConnHost {
    readonly hostname: string
    readonly isFallback: boolean
}

export interface WaMediaConn {
    readonly auth: string
    readonly expiresAtMs: number
    readonly hosts: readonly WaMediaConnHost[]
}

export interface WaDirtyBit {
    readonly type: string
    readonly timestamp: number
    readonly protocols: readonly string[]
}

export type WaStreamControlNodeResult =
    | { readonly kind: 'xmlstreamend' }
    | { readonly kind: 'stream_error_code'; readonly code: number }
    | { readonly kind: 'stream_error_replaced' }
    | { readonly kind: 'stream_error_device_removed' }
    | { readonly kind: 'stream_error_ack'; readonly id?: string }
    | { readonly kind: 'stream_error_xml_not_well_formed' }
    | { readonly kind: 'stream_error_other' }

export interface WaClientEventMap {
    readonly qr: (qr: string, ttlMs: number) => void
    readonly pairing_code: (code: string) => void
    readonly pairing_refresh: (forceManual: boolean) => void
    readonly paired: (credentials: WaAuthCredentials) => void
    readonly success: (node: BinaryNode) => void
    readonly error: (error: Error) => void
    readonly connected: () => void
    readonly disconnected: () => void
    readonly frame_in: (frame: Uint8Array) => void
    readonly frame_out: (frame: Uint8Array) => void
    readonly node_in: (node: BinaryNode, frame: Uint8Array) => void
    readonly node_out: (node: BinaryNode, frame: Uint8Array) => void
    readonly decode_error: (error: Error, frame: Uint8Array) => void
}

export type { WaSendMediaType, WaSendMediaData, WaSendMediaMessage, WaSendMessageContent } from '../message/types'
