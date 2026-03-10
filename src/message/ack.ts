import type { BinaryNode } from '../transport/types'

import {
    ACK_ATTR_CLASS,
    ACK_ATTR_CODE,
    ACK_ATTR_TYPE,
    ACK_CLASS_ERROR,
    ACK_NODE_TAG,
    ACK_TYPE_ERROR,
    ERROR_NODE_TAG,
    RECEIPT_NODE_TAG,
    RETRYABLE_ACK_CODES
} from './constants'

export function isAckOrReceiptNode(node: BinaryNode): boolean {
    return node.tag === ACK_NODE_TAG || node.tag === RECEIPT_NODE_TAG
}

export function isNegativeAckNode(node: BinaryNode): boolean {
    if (node.tag === ERROR_NODE_TAG) {
        return true
    }
    if (node.tag !== ACK_NODE_TAG) {
        return false
    }
    const ackType = node.attrs[ACK_ATTR_TYPE]
    const ackClass = node.attrs[ACK_ATTR_CLASS]
    return ackType === ACK_TYPE_ERROR || ackClass === ACK_CLASS_ERROR
}

export function isRetryableNegativeAck(node: BinaryNode): boolean {
    const code = node.attrs[ACK_ATTR_CODE]
    if (code && RETRYABLE_ACK_CODES.includes(code as (typeof RETRYABLE_ACK_CODES)[number])) {
        return true
    }
    const ackType = node.attrs[ACK_ATTR_TYPE]
    if (ackType && (ackType === 'wait' || ackType === 'retry' || ackType === 'timeout')) {
        return true
    }
    return false
}

export function describeAckNode(node: BinaryNode): string {
    const parts = [`tag=${node.tag}`]
    const id = node.attrs.id
    const type = node.attrs[ACK_ATTR_TYPE]
    const ackClass = node.attrs[ACK_ATTR_CLASS]
    const code = node.attrs[ACK_ATTR_CODE]
    if (id) {
        parts.push(`id=${id}`)
    }
    if (type) {
        parts.push(`type=${type}`)
    }
    if (ackClass) {
        parts.push(`class=${ackClass}`)
    }
    if (code) {
        parts.push(`code=${code}`)
    }
    return parts.join(' ')
}
