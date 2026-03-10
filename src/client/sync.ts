import type { Logger } from '../infra/log/types'
import { GROUP_SERVER, USER_SERVER } from '../transport/constants'
import { getNodeChildren } from '../transport/node/helpers'
import { buildIqNode } from '../transport/node/query'
import type { BinaryNode } from '../transport/types'

import {
    ACCOUNT_SYNC_PROTOCOLS,
    BLOCKLIST_XMLNS,
    DIRTY_BITS_XMLNS,
    GROUPS_XMLNS,
    NEWSLETTER_XMLNS,
    PRIVACY_XMLNS,
    PROFILE_PICTURE_XMLNS,
    SUPPORTED_DIRTY_TYPES,
    USYNC_CONTEXT_NOTIFICATION,
    USYNC_MODE_QUERY,
    USYNC_XMLNS
} from './constants'
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

export function resolveAccountSyncProtocols(protocols: readonly string[]): readonly string[] {
    const selected = protocols.filter((protocol) => ACCOUNT_SYNC_PROTOCOLS.includes(protocol))
    if (selected.length > 0) {
        return selected
    }
    return ACCOUNT_SYNC_PROTOCOLS
}

export function buildAccountDevicesSyncIq(meJid: string, sid: string): BinaryNode {
    return buildIqNode('get', USER_SERVER, USYNC_XMLNS, [
        {
            tag: 'usync',
            attrs: {
                sid,
                index: '0',
                last: 'true',
                mode: USYNC_MODE_QUERY,
                context: USYNC_CONTEXT_NOTIFICATION
            },
            content: [
                {
                    tag: 'query',
                    attrs: {},
                    content: [
                        {
                            tag: 'devices',
                            attrs: {
                                version: '2'
                            }
                        }
                    ]
                },
                {
                    tag: 'list',
                    attrs: {},
                    content: [
                        {
                            tag: 'user',
                            attrs: {
                                jid: meJid
                            }
                        }
                    ]
                }
            ]
        }
    ])
}

export function buildAccountPictureSyncIq(meJid: string): BinaryNode {
    return buildIqNode(
        'get',
        USER_SERVER,
        PROFILE_PICTURE_XMLNS,
        [
            {
                tag: 'picture',
                attrs: {
                    type: 'image',
                    query: 'url'
                }
            }
        ],
        {
            target: meJid
        }
    )
}

export function buildAccountPrivacySyncIq(): BinaryNode {
    return buildIqNode('get', USER_SERVER, PRIVACY_XMLNS, [
        {
            tag: 'privacy',
            attrs: {}
        }
    ])
}

export function buildAccountBlocklistSyncIq(): BinaryNode {
    return buildIqNode('get', USER_SERVER, BLOCKLIST_XMLNS)
}

export function buildGroupsDirtySyncIq(): BinaryNode {
    return buildIqNode('get', GROUP_SERVER, GROUPS_XMLNS, [
        {
            tag: 'participating',
            attrs: {},
            content: [
                {
                    tag: 'participants',
                    attrs: {}
                },
                {
                    tag: 'description',
                    attrs: {}
                }
            ]
        }
    ])
}

export function buildNewsletterMetadataSyncIq(): BinaryNode {
    return buildIqNode('get', USER_SERVER, NEWSLETTER_XMLNS, [
        {
            tag: 'my_addons',
            attrs: {
                limit: '1'
            }
        }
    ])
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
