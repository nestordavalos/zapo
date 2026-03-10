import type { WaAuthClientOptions, WaAuthSocketOptions } from '../auth/client.types'
import type { WaAuthCredentials } from '../auth/types'
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
export type { WaMediaConn, WaMediaConnHost } from '../media/types'
export type { WaDirtyBit } from './sync/types'
export type { WaStreamControlNodeResult } from '../transport/stream/types'
