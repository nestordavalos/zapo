import { USER_SERVER } from '../transport/constants'
import { findNodeChild, getNodeChildrenByTag } from '../transport/node/helpers'
import { assertIqResult, buildIqNode } from '../transport/node/query'
import type { BinaryNode } from '../transport/types'

import { MEDIA_XMLNS } from './constants'
import type { WaMediaConn } from './types'

export function buildMediaConnIq(): BinaryNode {
    return buildIqNode('set', USER_SERVER, MEDIA_XMLNS, [
        {
            tag: 'media_conn',
            attrs: {}
        }
    ])
}

export function parseMediaConnResponse(node: BinaryNode, nowMs: number): WaMediaConn {
    assertIqResult(node, 'media_conn')

    const mediaConnNode = findNodeChild(node, 'media_conn')
    if (!mediaConnNode) {
        throw new Error('media_conn response is missing media_conn node')
    }

    const auth = mediaConnNode.attrs.auth
    if (!auth) {
        throw new Error('media_conn response is missing auth')
    }
    const ttlRaw = Number.parseInt(mediaConnNode.attrs.ttl ?? '0', 10)
    if (!Number.isFinite(ttlRaw) || ttlRaw <= 0) {
        throw new Error('media_conn response has invalid ttl')
    }

    const expiresAtMs = ttlRaw >= 1_000_000_000 ? ttlRaw * 1000 : nowMs + ttlRaw * 1000
    const hosts = getNodeChildrenByTag(mediaConnNode, 'host')
        .map((host) => ({
            hostname: host.attrs.hostname ?? '',
            isFallback: host.attrs.type === 'fallback'
        }))
        .filter((host) => host.hostname.length > 0)
    if (hosts.length === 0) {
        throw new Error('media_conn response contains no hosts')
    }

    return {
        auth,
        expiresAtMs,
        hosts
    }
}
