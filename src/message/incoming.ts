import type { BinaryNode } from '../transport/types'

import {
    ACK_CLASS_MESSAGE,
    ACK_NODE_TAG,
    MESSAGE_MEDIA_NOTIFY_TYPE,
    MESSAGE_NODE_TAG,
    RECEIPT_NODE_TAG,
    RECEIPT_TYPE_PEER
} from './constants'
import type { WaIncomingMessageAckHandlerOptions } from './types'

export function buildInboundMessageAckNode(
    messageNode: BinaryNode,
    id: string,
    to: string,
    meJid: string | null | undefined
): BinaryNode {
    const attrs: Record<string, string> = {
        id,
        to,
        class: ACK_CLASS_MESSAGE
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
        tag: ACK_NODE_TAG,
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
        attrs.type = RECEIPT_TYPE_PEER
    }
    return {
        tag: RECEIPT_NODE_TAG,
        attrs
    }
}

export async function handleIncomingMessageAck(
    node: BinaryNode,
    options: WaIncomingMessageAckHandlerOptions
): Promise<boolean> {
    if (node.tag !== MESSAGE_NODE_TAG) {
        return false
    }

    const id = node.attrs.id
    const from = node.attrs.from
    if (!id || !from) {
        options.logger.warn('incoming message missing required attrs for ack/receipt', {
            hasId: Boolean(id),
            hasFrom: Boolean(from),
            type: node.attrs.type
        })
        return false
    }

    if (node.attrs.type === MESSAGE_MEDIA_NOTIFY_TYPE) {
        const ackNode = buildInboundMessageAckNode(node, id, from, options.getMeJid?.())
        options.logger.debug('sending inbound message ack', {
            id,
            to: from,
            type: ackNode.attrs.type,
            participant: ackNode.attrs.participant
        })
        await options.sendNode(ackNode)
        return true
    }

    const receiptNode = buildInboundDeliveryReceiptNode(node, id, from)
    options.logger.debug('sending inbound message receipt', {
        id,
        to: from,
        type: receiptNode.attrs.type,
        participant: receiptNode.attrs.participant
    })
    await options.sendNode(receiptNode)
    return true
}
