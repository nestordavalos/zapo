import { WA_MESSAGE_TAGS, WA_MESSAGE_TYPES } from '@protocol/constants'
import type { BinaryNode } from '@transport/types'

export function buildInboundMessageAckNode(
    messageNode: BinaryNode,
    id: string,
    to: string,
    meJid: string | null | undefined
): BinaryNode {
    const attrs: Record<string, string> = {
        id,
        to,
        class: WA_MESSAGE_TYPES.ACK_CLASS_MESSAGE
    }
    if (messageNode.attrs.type) {
        attrs.type = messageNode.attrs.type
    }
    if (messageNode.attrs.participant) {
        attrs.participant = messageNode.attrs.participant
    }
    if (meJid) {
        attrs.from = meJid
    }
    return {
        tag: WA_MESSAGE_TAGS.ACK,
        attrs
    }
}

export function buildInboundDeliveryReceiptNode(
    messageNode: BinaryNode,
    id: string,
    to: string
): BinaryNode {
    const attrs: Record<string, string> = {
        id,
        to
    }
    if (messageNode.attrs.participant) {
        attrs.participant = messageNode.attrs.participant
    }
    if (messageNode.attrs.category === 'peer') {
        attrs.type = WA_MESSAGE_TYPES.RECEIPT_TYPE_PEER
    }
    return {
        tag: WA_MESSAGE_TAGS.RECEIPT,
        attrs
    }
}
