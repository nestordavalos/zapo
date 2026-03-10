import type { WaSuccessPersistAttributes } from '../../auth/types'
import { base64ToBytes } from '../../util/base64'
import {
    STREAM_ERROR_ACK_TAG,
    STREAM_ERROR_CONFLICT_TAG,
    STREAM_ERROR_NODE_TAG,
    STREAM_ERROR_REPLACED_TYPE,
    STREAM_ERROR_XML_NOT_WELL_FORMED_TAG,
    XML_STREAM_END_NODE_TAG
} from '../constants'
import { findNodeChild, hasNodeChild } from '../node/helpers'
import type { BinaryNode } from '../types'

import type { WaStreamControlNodeResult } from './types'

export function parseStreamControlNode(node: BinaryNode): WaStreamControlNodeResult | null {
    if (node.tag === XML_STREAM_END_NODE_TAG) {
        return {
            kind: 'xmlstreamend'
        }
    }
    if (node.tag !== STREAM_ERROR_NODE_TAG) {
        return null
    }

    const conflictNode = findNodeChild(node, STREAM_ERROR_CONFLICT_TAG)
    if (conflictNode) {
        if (conflictNode.attrs.type === STREAM_ERROR_REPLACED_TYPE) {
            return {
                kind: 'stream_error_replaced'
            }
        }
        return {
            kind: 'stream_error_device_removed'
        }
    }

    const codeRaw = node.attrs.code
    if (codeRaw) {
        const code = Number.parseInt(codeRaw, 10)
        if (Number.isFinite(code)) {
            return {
                kind: 'stream_error_code',
                code
            }
        }
    }

    const ackNode = findNodeChild(node, STREAM_ERROR_ACK_TAG)
    if (ackNode) {
        return {
            kind: 'stream_error_ack',
            id: ackNode.attrs.id
        }
    }

    if (hasNodeChild(node, STREAM_ERROR_XML_NOT_WELL_FORMED_TAG)) {
        return {
            kind: 'stream_error_xml_not_well_formed'
        }
    }

    return {
        kind: 'stream_error_other'
    }
}

export function parseOptionalInt(value: string | undefined): number | undefined {
    if (!value) {
        return undefined
    }
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed)) {
        return undefined
    }
    return parsed
}

export function parseCompanionEncStatic(
    value: string | undefined,
    onError?: (error: Error) => void
): Uint8Array | undefined {
    if (!value) {
        return undefined
    }
    try {
        return base64ToBytes(value, 'success.companion_enc_static')
    } catch (error) {
        if (error instanceof Error) {
            onError?.(error)
        }
        return undefined
    }
}

export function parseSuccessPersistAttributes(
    node: BinaryNode,
    onCompanionParseError?: (error: Error) => void
): WaSuccessPersistAttributes {
    return {
        meLid: node.attrs.lid,
        meDisplayName: node.attrs.display_name,
        companionEncStatic: parseCompanionEncStatic(
            node.attrs.companion_enc_static,
            onCompanionParseError
        ),
        lastSuccessTs: parseOptionalInt(node.attrs.t),
        propsVersion: parseOptionalInt(node.attrs.props),
        abPropsVersion: parseOptionalInt(node.attrs.abprops),
        connectionLocation: node.attrs.location,
        accountCreationTs: parseOptionalInt(node.attrs.creation)
    }
}
