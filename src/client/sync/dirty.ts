import type { Logger } from '../../infra/log/types'
import { USER_SERVER } from '../../transport/constants'
import { getNodeChildren } from '../../transport/node/helpers'
import { buildIqNode } from '../../transport/node/query'
import type { BinaryNode } from '../../transport/types'
import { DIRTY_BITS_XMLNS, SUPPORTED_DIRTY_TYPES } from '../constants'

import type { WaDirtyBit } from './types'

export function parseDirtyBitNode(node: BinaryNode, logger: Logger): WaDirtyBit | null {
    const type = node.attrs.type
    const timestamp = Number.parseInt(node.attrs.timestamp ?? '', 10)
    if (!type || !Number.isFinite(timestamp)) {
        logger.warn('received invalid dirty bit node', {
            type,
            timestamp: node.attrs.timestamp
        })
        return null
    }
    const protocols = getNodeChildren(node).map((child) => child.tag)
    return {
        type,
        timestamp,
        protocols
    }
}

export function splitDirtyBitsBySupport(dirtyBits: readonly WaDirtyBit[]): {
    readonly supported: WaDirtyBit[]
    readonly unsupported: WaDirtyBit[]
} {
    const supported: WaDirtyBit[] = []
    const unsupported: WaDirtyBit[] = []
    for (let index = 0; index < dirtyBits.length; index += 1) {
        const dirtyBit = dirtyBits[index]
        if (SUPPORTED_DIRTY_TYPES.includes(dirtyBit.type)) {
            supported.push(dirtyBit)
        } else {
            unsupported.push(dirtyBit)
        }
    }
    return {
        supported,
        unsupported
    }
}

export function buildClearDirtyBitsIq(dirtyBits: readonly WaDirtyBit[]): BinaryNode {
    return buildIqNode(
        'set',
        USER_SERVER,
        DIRTY_BITS_XMLNS,
        dirtyBits.map((dirtyBit) => ({
            tag: 'clean',
            attrs: {
                type: dirtyBit.type,
                timestamp: `${dirtyBit.timestamp}`
            }
        }))
    )
}
