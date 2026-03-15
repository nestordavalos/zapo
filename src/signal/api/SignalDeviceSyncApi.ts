import { randomInt } from 'node:crypto'

import type { Logger } from '@infra/log/types'
import { WA_DEFAULTS, WA_NODE_TAGS, WA_XMLNS } from '@protocol/constants'
import { parseSignalAddressFromJid, splitJid } from '@protocol/jid'
import type { WaDeviceListStore } from '@store/contracts/device-list.store'
import { findNodeChild, getNodeChildrenByTag } from '@transport/node/helpers'
import { assertIqResult, buildIqNode } from '@transport/node/query'
import type { BinaryNode } from '@transport/types'

interface SignalDeviceSyncApiOptions {
    readonly logger: Logger
    readonly query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
    readonly deviceListStore?: WaDeviceListStore
    readonly defaultTimeoutMs?: number
    readonly hostDomain?: string
}

export class SignalDeviceSyncApi {
    private readonly logger: SignalDeviceSyncApiOptions['logger']
    private readonly query: SignalDeviceSyncApiOptions['query']
    private readonly deviceListStore?: WaDeviceListStore
    private readonly defaultTimeoutMs: number
    private readonly hostDomain: string

    public constructor(options: SignalDeviceSyncApiOptions) {
        this.logger = options.logger
        this.query = options.query
        this.deviceListStore = options.deviceListStore
        this.defaultTimeoutMs =
            options.defaultTimeoutMs ?? WA_DEFAULTS.SIGNAL_FETCH_KEY_BUNDLES_TIMEOUT_MS
        this.hostDomain = options.hostDomain ?? WA_DEFAULTS.HOST_DOMAIN
    }

    public async syncDeviceList(
        userJids: readonly string[],
        timeoutMs = this.defaultTimeoutMs
    ): Promise<readonly { readonly jid: string; readonly deviceJids: readonly string[] }[]> {
        const normalizedUsers = this.normalizeUsers(userJids)
        if (normalizedUsers.length === 0) {
            return []
        }

        const nowMs = Date.now()
        const cachedByUser = new Map<string, readonly string[]>()
        const usersToQuery = this.deviceListStore
            ? await this.collectUsersToQuery(
                  normalizedUsers,
                  nowMs,
                  cachedByUser,
                  this.deviceListStore
              )
            : normalizedUsers

        if (usersToQuery.length === 0) {
            return normalizedUsers.flatMap((jid) => {
                const deviceJids = cachedByUser.get(jid)
                return deviceJids ? [{ jid, deviceJids }] : []
            })
        }

        const request = this.makeDeviceSyncRequest(usersToQuery)
        this.logger.debug('signal device sync request', {
            users: usersToQuery.length,
            timeoutMs
        })
        const response = await this.query(request, timeoutMs)
        const parsed = this.parseDeviceSyncResponse(response, usersToQuery)
        if (this.deviceListStore) {
            const updatedAtMs = Date.now()
            await this.deviceListStore.upsertUserDevicesBatch(
                parsed.map((entry) => ({
                    userJid: entry.jid,
                    deviceJids: entry.deviceJids,
                    updatedAtMs
                }))
            )
        }
        const parsedByUser = new Map<string, readonly string[]>(
            parsed.map((entry) => [entry.jid, entry.deviceJids])
        )
        const merged = normalizedUsers.flatMap((jid) => {
            const parsedDeviceJids = parsedByUser.get(jid)
            if (parsedDeviceJids) {
                return [{ jid, deviceJids: parsedDeviceJids }]
            }
            const cachedDeviceJids = cachedByUser.get(jid)
            return cachedDeviceJids ? [{ jid, deviceJids: cachedDeviceJids }] : []
        })
        this.logger.debug('signal device sync success', {
            users: merged.length,
            devices: merged.reduce((total, entry) => total + entry.deviceJids.length, 0)
        })
        return merged
    }

    private async collectUsersToQuery(
        normalizedUsers: readonly string[],
        nowMs: number,
        cachedByUser: Map<string, readonly string[]>,
        store: WaDeviceListStore
    ): Promise<readonly string[]> {
        const records = await store.getUserDevicesBatch(normalizedUsers, nowMs)
        const usersToQuery: string[] = []
        for (let index = 0; index < normalizedUsers.length; index += 1) {
            const userJid = normalizedUsers[index]
            const record = records[index]
            if (!record) {
                usersToQuery.push(userJid)
                continue
            }
            cachedByUser.set(userJid, record.deviceJids)
        }
        return usersToQuery
    }

    private makeDeviceSyncRequest(userJids: readonly string[]): BinaryNode {
        return buildIqNode('get', this.hostDomain, WA_XMLNS.USYNC, [
            {
                tag: WA_NODE_TAGS.USYNC,
                attrs: {
                    sid: this.makeSid(),
                    index: '0',
                    last: 'true',
                    mode: WA_NODE_TAGS.QUERY,
                    context: 'interactive'
                },
                content: [
                    {
                        tag: WA_NODE_TAGS.QUERY,
                        attrs: {},
                        content: [
                            {
                                tag: WA_NODE_TAGS.DEVICES,
                                attrs: {
                                    version: '2'
                                }
                            }
                        ]
                    },
                    {
                        tag: WA_NODE_TAGS.LIST,
                        attrs: {},
                        content: userJids.map((jid) => ({
                            tag: WA_NODE_TAGS.USER,
                            attrs: { jid }
                        }))
                    }
                ]
            }
        ])
    }

    private parseDeviceSyncResponse(
        node: BinaryNode,
        requestedUsers: readonly string[]
    ): readonly { readonly jid: string; readonly deviceJids: readonly string[] }[] {
        assertIqResult(node, 'signal device sync')
        const usyncNode = findNodeChild(node, WA_NODE_TAGS.USYNC)
        if (!usyncNode) {
            throw new Error('signal device sync response missing usync node')
        }
        const listNode = findNodeChild(usyncNode, WA_NODE_TAGS.LIST)
        if (!listNode) {
            throw new Error('signal device sync response missing list node')
        }

        const requestedSet = new Set(requestedUsers)
        const userNodes = getNodeChildrenByTag(listNode, WA_NODE_TAGS.USER)
        return userNodes.flatMap((userNode) => {
            const userJid = userNode.attrs.jid
            if (!userJid) {
                return []
            }
            const normalizedUserJid = this.normalizeUserJid(userJid)
            if (!requestedSet.has(normalizedUserJid)) {
                return []
            }
            return [
                {
                    jid: normalizedUserJid,
                    deviceJids: this.parseUserDeviceJids(userNode, normalizedUserJid)
                }
            ]
        })
    }

    private parseUserDeviceJids(userNode: BinaryNode, userJid: string): readonly string[] {
        const devicesNode = findNodeChild(userNode, WA_NODE_TAGS.DEVICES)
        if (!devicesNode) {
            return []
        }
        const errorNode = findNodeChild(devicesNode, WA_NODE_TAGS.ERROR)
        if (errorNode) {
            this.logger.warn('signal device sync user error', {
                jid: userJid,
                code: errorNode.attrs.code,
                text: errorNode.attrs.text
            })
            return []
        }

        const deviceListNode = findNodeChild(devicesNode, 'device-list')
        if (!deviceListNode) {
            return []
        }

        return [
            ...new Set(
                getNodeChildrenByTag(deviceListNode, 'device')
                    .map((deviceNode) => {
                        const parsedId = deviceNode.attrs.id
                            ? Number.parseInt(deviceNode.attrs.id, 10)
                            : Number.NaN
                        return Number.isSafeInteger(parsedId) && parsedId >= 0
                            ? this.toDeviceJid(userJid, parsedId)
                            : null
                    })
                    .filter((jid): jid is string => jid !== null)
            )
        ]
    }

    private normalizeUsers(userJids: readonly string[]): readonly string[] {
        return [...new Set(userJids.map((jid) => this.normalizeUserJid(jid)))]
    }

    private normalizeUserJid(jid: string): string {
        const { user } = parseSignalAddressFromJid(jid)
        const { server } = splitJid(jid)
        return `${user}@${server}`
    }

    private toDeviceJid(userJid: string, deviceId: number): string {
        const parsed = splitJid(userJid)
        if (deviceId === 0) {
            return `${parsed.user}@${parsed.server}`
        }
        return `${parsed.user}:${deviceId}@${parsed.server}`
    }

    private makeSid(): string {
        return `${Date.now()}.${randomInt(1_000_000)}`
    }
}
