import { WA_DEFAULTS, WA_NODE_TAGS, WA_XMLNS } from '@protocol/constants'
import { buildIqNode } from '@transport/node/query'
import type { BinaryNode } from '@transport/types'


export function buildMediaConnIq(): BinaryNode {
    return buildIqNode('set', WA_DEFAULTS.HOST_DOMAIN, WA_XMLNS.MEDIA, [
        {
            tag: WA_NODE_TAGS.MEDIA_CONN,
            attrs: {}
        }
    ])
}
