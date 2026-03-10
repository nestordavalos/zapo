import type { Logger } from '../infra/log/types'
import type { Proto } from '../proto'
import type { BinaryNode } from '../transport/types'

export type ProtoMessage = Proto.IMessage
export type ProtoWebMessageInfo = Proto.IWebMessageInfo
export type ProtoMessageKey = Proto.IMessageKey

export type OutgoingMessageKind =
    | 'text'
    | 'image'
    | 'video'
    | 'audio'
    | 'document'
    | 'sticker'
    | 'reaction'
    | 'location'
    | 'contact'

export interface OutgoingMessage {
    readonly kind: OutgoingMessageKind
    readonly chatJid: string
    readonly message: ProtoMessage
}

export type MessageEncType = 'msg' | 'pkmsg' | 'skmsg'

export interface WaMessagePublishOptions {
    readonly ackTimeoutMs?: number
    readonly maxAttempts?: number
    readonly retryDelayMs?: number
}

export interface WaMessagePublishResult {
    readonly id: string
    readonly attempts: number
    readonly ackNode: BinaryNode
}

export type WaSendMediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export type WaSendMediaData = Uint8Array | ArrayBuffer

export interface WaSendMediaMessage {
    readonly type: WaSendMediaType
    readonly media: WaSendMediaData
    readonly mimetype: string
    readonly caption?: string
    readonly fileName?: string
    readonly ptt?: boolean
    readonly gifPlayback?: boolean
    readonly seconds?: number
    readonly width?: number
    readonly height?: number
}

export type WaSendMessageContent = string | Proto.IMessage | WaSendMediaMessage

export interface WaEncryptedMessageInput {
    readonly to: string
    readonly encType: MessageEncType
    readonly ciphertext: Uint8Array
    readonly id?: string
    readonly type?: string
    readonly participant?: string
    readonly deviceFanout?: string
}

export interface WaSendReceiptInput {
    readonly to: string
    readonly id: string
    readonly type?: string
    readonly participant?: string
    readonly from?: string
    readonly t?: string
}

export interface WaMessageClientOptions {
    readonly logger: Logger
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
}

export interface WaIncomingMessageAckHandlerOptions {
    readonly logger: Logger
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly getMeJid?: () => string | null | undefined
}
