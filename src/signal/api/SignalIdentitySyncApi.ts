import { toSerializedPubKey } from '@crypto/core/keys'
import type { Logger } from '@infra/log/types'
import { WA_DEFAULTS, WA_IQ_TYPES, WA_NODE_TAGS, WA_XMLNS } from '@protocol/constants'
import { normalizeDeviceJid, parseSignalAddressFromJid } from '@protocol/jid'
import { decodeExactLength, parseUint } from '@signal/api/codec'
import { SIGNAL_KEY_BUNDLE_TYPE_LENGTH, SIGNAL_KEY_DATA_LENGTH } from '@signal/api/constants'
import type { WaSignalStore } from '@store/contracts/signal.store'
import { findNodeChild, getNodeChildrenByTag } from '@transport/node/helpers'
import { assertIqResult } from '@transport/node/query'
import type { BinaryNode } from '@transport/types'

export interface SignalIdentitySyncEntry {
    readonly jid: string
    readonly identity: Uint8Array
    readonly type?: number
}

interface SignalIdentitySyncApiOptions {
    readonly logger: Logger
    readonly query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
    readonly signalStore?: WaSignalStore
    readonly defaultTimeoutMs?: number
    readonly hostDomain?: string
}

export class SignalIdentitySyncApi {
    private readonly logger: SignalIdentitySyncApiOptions['logger']
    private readonly query: SignalIdentitySyncApiOptions['query']
    private readonly signalStore?: WaSignalStore
    private readonly defaultTimeoutMs: number
    private readonly hostDomain: string

    public constructor(options: SignalIdentitySyncApiOptions) {
        this.logger = options.logger
        this.query = options.query
        this.signalStore = options.signalStore
        this.defaultTimeoutMs =
            options.defaultTimeoutMs ?? WA_DEFAULTS.SIGNAL_FETCH_KEY_BUNDLES_TIMEOUT_MS
        this.hostDomain = options.hostDomain ?? WA_DEFAULTS.HOST_DOMAIN
    }

    public async syncIdentityKeys(
        targetJids: readonly string[],
        timeoutMs = this.defaultTimeoutMs
    ): Promise<readonly SignalIdentitySyncEntry[]> {
        const normalizedTargets = [...new Set(targetJids.map((jid) => normalizeDeviceJid(jid)))]
        if (normalizedTargets.length === 0) {
            return []
        }

        this.logger.debug('signal identity sync request', {
            targets: normalizedTargets.length,
            timeoutMs
        })
        const response = await this.query(
            {
                tag: WA_NODE_TAGS.IQ,
                attrs: {
                    type: WA_IQ_TYPES.GET,
                    xmlns: WA_XMLNS.SIGNAL,
                    to: this.hostDomain
                },
                content: [
                    {
                        tag: WA_NODE_TAGS.IDENTITY,
                        attrs: {},
                        content: normalizedTargets.map((jid) => ({
                            tag: WA_NODE_TAGS.USER,
                            attrs: { jid }
                        }))
                    }
                ]
            },
            timeoutMs
        )

        const entries = this.parseIdentitySyncResponse(response, normalizedTargets)
        const { signalStore } = this
        if (signalStore && entries.length > 0) {
            await signalStore.setRemoteIdentities(
                entries.map((entry) => ({
                    address: parseSignalAddressFromJid(entry.jid),
                    identityKey: toSerializedPubKey(entry.identity)
                }))
            )
        }
        this.logger.debug('signal identity sync success', {
            requested: normalizedTargets.length,
            synced: entries.length
        })
        return entries
    }

    private parseIdentitySyncResponse(
        node: BinaryNode,
        requestedJids: readonly string[]
    ): readonly SignalIdentitySyncEntry[] {
        assertIqResult(node, 'identity sync')

        const listNode = findNodeChild(node, WA_NODE_TAGS.LIST)
        if (!listNode) {
            throw new Error('identity sync response missing list node')
        }

        const requested = new Set(requestedJids)
        const userNodes = getNodeChildrenByTag(listNode, WA_NODE_TAGS.USER)
        return userNodes.flatMap((userNode): readonly SignalIdentitySyncEntry[] => {
            const jid = userNode.attrs.jid ? normalizeDeviceJid(userNode.attrs.jid) : ''
            if (!jid || !requested.has(jid)) {
                return []
            }
            const errorNode = findNodeChild(userNode, WA_NODE_TAGS.ERROR)
            if (errorNode) {
                this.logger.warn('signal identity sync user error', {
                    jid,
                    code: errorNode.attrs.code,
                    text: errorNode.attrs.text
                })
                return []
            }

            const identityNode = findNodeChild(userNode, WA_NODE_TAGS.IDENTITY)
            if (!identityNode) {
                throw new Error(`identity sync user missing identity node for ${jid}`)
            }
            const typeNode = findNodeChild(userNode, WA_NODE_TAGS.TYPE)

            const identity = decodeExactLength(
                identityNode.content,
                'identity sync identity',
                SIGNAL_KEY_DATA_LENGTH
            )
            const parsedType = typeNode
                ? parseUint(
                      decodeExactLength(
                          typeNode.content,
                          'identity sync type',
                          SIGNAL_KEY_BUNDLE_TYPE_LENGTH
                      ),
                      'identity sync type'
                  )
                : undefined

            return [
                {
                    jid,
                    identity,
                    ...(parsedType !== undefined ? { type: parsedType } : {})
                }
            ]
        })
    }
}
