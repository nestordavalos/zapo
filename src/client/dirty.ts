import type { WaAuthCredentials } from '@auth/types'
import { randomBytesAsync } from '@crypto'
import type { Logger } from '@infra/log/types'
import {
    WA_ACCOUNT_SYNC_PROTOCOLS,
    WA_DEFAULTS,
    WA_DIRTY_PROTOCOLS,
    WA_DIRTY_TYPES,
    WA_IQ_TYPES,
    WA_SUPPORTED_DIRTY_TYPES
} from '@protocol/constants'
import { toUserJid } from '@protocol/jid'
import {
    buildAccountBlocklistSyncIq,
    buildAccountDevicesSyncIq,
    buildAccountPictureSyncIq,
    buildAccountPrivacySyncIq,
    buildClearDirtyBitsIq,
    buildGroupsDirtySyncIq,
    buildNewsletterMetadataSyncIq
} from '@transport/node/builders/accountSync'
import { getNodeChildren } from '@transport/node/helpers'
import { assertIqResult, parseIqError } from '@transport/node/query'
import type { BinaryNode } from '@transport/types'
import { toError } from '@util/primitives'

export interface WaDirtyBit {
    readonly type: string
    readonly timestamp: number
    readonly protocols: readonly string[]
}

interface WaDirtySyncRuntime {
    readonly logger: Logger
    readonly queryWithContext: (
        context: string,
        node: BinaryNode,
        timeoutMs?: number,
        contextData?: Readonly<Record<string, unknown>>
    ) => Promise<BinaryNode>
    readonly getCurrentCredentials: () => WaAuthCredentials | null
    readonly syncAppState: () => Promise<void>
}

type DirtyBitHandler = (runtime: WaDirtySyncRuntime, dirtyBit: WaDirtyBit) => Promise<void>
type AccountSyncHandler = (runtime: WaDirtySyncRuntime) => Promise<void>
const SUPPORTED_DIRTY_TYPES = new Set<string>(WA_SUPPORTED_DIRTY_TYPES)
const ACCOUNT_SYNC_PROTOCOL_SET = new Set<string>(WA_ACCOUNT_SYNC_PROTOCOLS)

const DIRTY_BIT_HANDLERS: Readonly<Record<string, DirtyBitHandler>> = {
    [WA_DIRTY_TYPES.ACCOUNT_SYNC]: async (runtime, dirtyBit) =>
        handleAccountSyncDirtyBit(runtime, dirtyBit.protocols),
    [WA_DIRTY_TYPES.SYNCD_APP_STATE]: async (runtime) => handleSyncdAppStateDirtyBit(runtime),
    [WA_DIRTY_TYPES.GROUPS]: async (runtime) => syncGroupsDirtyBit(runtime),
    [WA_DIRTY_TYPES.NEWSLETTER_METADATA]: async (runtime) => syncNewsletterMetadataDirtyBit(runtime)
}

const ACCOUNT_SYNC_HANDLERS: Readonly<Record<string, AccountSyncHandler>> = {
    [WA_DIRTY_PROTOCOLS.DEVICES]: async (runtime) => syncAccountDevicesDirtyBit(runtime),
    [WA_DIRTY_PROTOCOLS.PICTURE]: async (runtime) => syncAccountPictureDirtyBit(runtime),
    [WA_DIRTY_PROTOCOLS.PRIVACY]: async (runtime) => syncAccountPrivacyDirtyBit(runtime),
    [WA_DIRTY_PROTOCOLS.BLOCKLIST]: async (runtime) => syncAccountBlocklistDirtyBit(runtime),
    [WA_DIRTY_PROTOCOLS.NOTICE]: async (runtime) => syncAccountNoticeDirtyBit(runtime)
}

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
        if (SUPPORTED_DIRTY_TYPES.has(dirtyBit.type)) {
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

function resolveAccountSyncProtocols(protocols: readonly string[]): readonly string[] {
    const selected = protocols.filter((protocol) => ACCOUNT_SYNC_PROTOCOL_SET.has(protocol))
    if (selected.length > 0) {
        return selected
    }
    return WA_ACCOUNT_SYNC_PROTOCOLS
}

export function parseDirtyBits(
    nodes: readonly BinaryNode[],
    logger: Logger
): readonly WaDirtyBit[] {
    const dirtyBits: WaDirtyBit[] = []
    for (let index = 0; index < nodes.length; index += 1) {
        const parsedDirtyBit = parseDirtyBitNode(nodes[index], logger)
        if (parsedDirtyBit) {
            dirtyBits.push(parsedDirtyBit)
        }
    }
    return dirtyBits
}

export async function handleDirtyBits(
    runtime: WaDirtySyncRuntime,
    dirtyBits: readonly WaDirtyBit[]
): Promise<void> {
    const meJid = runtime.getCurrentCredentials()?.meJid ?? null
    if (!meJid) {
        runtime.logger.trace('dirty bits skipped: session is not registered')
        return
    }

    const { supported, unsupported } = splitDirtyBitsBySupport(dirtyBits)

    runtime.logger.info('handling dirty bits from info bulletin', {
        supported: supported.map((entry) => entry.type).join(','),
        unsupported: unsupported.map((entry) => entry.type).join(',')
    })

    await Promise.all(
        supported.map(async (dirtyBit) => {
            try {
                await handleDirtyBit(runtime, dirtyBit)
            } catch (error) {
                runtime.logger.warn('failed handling dirty bit', {
                    type: dirtyBit.type,
                    message: toError(error).message
                })
            }
        })
    )

    await clearDirtyBits(runtime, unsupported.concat(supported))
}

async function handleDirtyBit(runtime: WaDirtySyncRuntime, dirtyBit: WaDirtyBit): Promise<void> {
    const handler = DIRTY_BIT_HANDLERS[dirtyBit.type]
    if (!handler) {
        runtime.logger.debug('received unsupported dirty bit', {
            type: dirtyBit.type
        })
        return
    }
    await handler(runtime, dirtyBit)
}

async function handleAccountSyncDirtyBit(
    runtime: WaDirtySyncRuntime,
    protocols: readonly string[]
): Promise<void> {
    const selectedProtocols = resolveAccountSyncProtocols(protocols)
    runtime.logger.info('received account_sync dirty bit', {
        protocols: selectedProtocols.join(',')
    })
    await Promise.all(
        selectedProtocols.map(async (protocol) => {
            try {
                await runAccountSyncProtocol(runtime, protocol)
            } catch (error) {
                runtime.logger.warn('account_sync protocol failed', {
                    protocol,
                    message: toError(error).message
                })
            }
        })
    )
}

async function runAccountSyncProtocol(
    runtime: WaDirtySyncRuntime,
    protocol: string
): Promise<void> {
    const handler = ACCOUNT_SYNC_HANDLERS[protocol]
    if (!handler) {
        runtime.logger.debug('unsupported account_sync protocol', {
            protocol
        })
        return
    }
    await handler(runtime)
}

async function handleSyncdAppStateDirtyBit(runtime: WaDirtySyncRuntime): Promise<void> {
    runtime.logger.info('received syncd_app_state dirty bit, starting sync')
    try {
        await runtime.syncAppState()
    } catch (error) {
        runtime.logger.warn('app-state sync failed after dirty bit', {
            message: toError(error).message
        })
    }
}

async function syncAccountDevicesDirtyBit(runtime: WaDirtySyncRuntime): Promise<void> {
    const credentials = runtime.getCurrentCredentials()
    const meJid = credentials?.meJid ?? null
    if (!meJid) {
        runtime.logger.warn('account_sync devices skipped: meJid is missing')
        return
    }

    const userJids = resolveAccountSyncDeviceTargets(credentials)
    if (userJids.length === 0) {
        runtime.logger.warn('account_sync devices skipped: no valid account_sync targets')
        return
    }

    await runSyncQuery(runtime, {
        queryContext: 'account_sync.devices',
        node: buildAccountDevicesSyncIq(userJids, await generateUsyncSid()),
        logMessage: 'account_sync devices synchronized',
        contextData: { meJid, targets: userJids.join(',') }
    })
}

async function syncAccountPictureDirtyBit(runtime: WaDirtySyncRuntime): Promise<void> {
    const meJid = requireCurrentMeJid(runtime, 'account_sync picture skipped: meJid is missing')
    if (!meJid) {
        return
    }
    const targetJid = toUserJid(meJid)
    const response = await runtime.queryWithContext(
        'account_sync.picture',
        buildAccountPictureSyncIq(targetJid),
        WA_DEFAULTS.IQ_TIMEOUT_MS,
        { meJid, target: targetJid }
    )

    if (response.tag !== 'iq') {
        throw new Error(`account_sync.picture returned non-iq node (${response.tag})`)
    }
    if (response.attrs.type === WA_IQ_TYPES.RESULT) {
        runtime.logger.debug('account_sync picture synchronized', {
            meJid,
            target: targetJid
        })
        return
    }

    const iqError = parseIqError(response)
    const isPictureMissing =
        (iqError.numericCode === 404 || iqError.code === '404') &&
        iqError.text.toLowerCase() === 'item-not-found'
    if (isPictureMissing) {
        runtime.logger.debug('account_sync picture skipped: no profile picture found', {
            meJid,
            target: targetJid
        })
        return
    }

    throw new Error(`account_sync.picture iq failed (${iqError.code}: ${iqError.text})`)
}

async function syncAccountPrivacyDirtyBit(runtime: WaDirtySyncRuntime): Promise<void> {
    await runSyncQuery(runtime, {
        queryContext: 'account_sync.privacy',
        node: buildAccountPrivacySyncIq(),
        logMessage: 'account_sync privacy synchronized'
    })
}

async function syncAccountBlocklistDirtyBit(runtime: WaDirtySyncRuntime): Promise<void> {
    await runSyncQuery(runtime, {
        queryContext: 'account_sync.blocklist',
        node: buildAccountBlocklistSyncIq(),
        logMessage: 'account_sync blocklist synchronized'
    })
}

async function syncAccountNoticeDirtyBit(runtime: WaDirtySyncRuntime): Promise<void> {
    runtime.logger.info('account_sync notice protocol received (no GraphQL/MEX job configured)')
}

async function syncGroupsDirtyBit(runtime: WaDirtySyncRuntime): Promise<void> {
    await runSyncQuery(runtime, {
        queryContext: 'dirty.groups',
        assertContext: 'groups',
        node: buildGroupsDirtySyncIq(),
        logMessage: 'groups dirty sync completed'
    })
}

async function syncNewsletterMetadataDirtyBit(runtime: WaDirtySyncRuntime): Promise<void> {
    runtime.logger.info(
        'newsletter_metadata dirty bit received (GraphQL/MEX sync intentionally disabled)'
    )
    await runtime
        .queryWithContext(
            'dirty.newsletter_metadata',
            buildNewsletterMetadataSyncIq(),
            WA_DEFAULTS.IQ_TIMEOUT_MS
        )
        .catch(() => undefined)
}

async function generateUsyncSid(): Promise<string> {
    const seed = await randomBytesAsync(8)
    return Buffer.from(seed).toString('hex')
}

function requireCurrentMeJid(runtime: WaDirtySyncRuntime, warnMessage: string): string | null {
    const meJid = runtime.getCurrentCredentials()?.meJid ?? null
    if (!meJid) {
        runtime.logger.warn(warnMessage)
        return null
    }
    return meJid
}

function resolveAccountSyncDeviceTargets(credentials: WaAuthCredentials | null): readonly string[] {
    if (!credentials?.meJid) {
        return []
    }

    const dedup = new Set<string>()
    dedup.add(toUserJid(credentials.meJid))
    if (credentials.meLid && credentials.meLid.includes('@')) {
        dedup.add(toUserJid(credentials.meLid))
    }
    return [...dedup]
}

async function runSyncQuery(
    runtime: WaDirtySyncRuntime,
    args: {
        readonly queryContext: string
        readonly node: BinaryNode
        readonly logMessage: string
        readonly assertContext?: string
        readonly contextData?: Readonly<Record<string, unknown>>
    }
): Promise<void> {
    const response = await runtime.queryWithContext(
        args.queryContext,
        args.node,
        WA_DEFAULTS.IQ_TIMEOUT_MS,
        args.contextData
    )
    assertIqResult(response, args.assertContext ?? args.queryContext)
    runtime.logger.debug(args.logMessage, args.contextData)
}

async function clearDirtyBits(
    runtime: WaDirtySyncRuntime,
    dirtyBits: readonly WaDirtyBit[]
): Promise<void> {
    try {
        await runtime.queryWithContext(
            'dirty.clear',
            buildClearDirtyBitsIq(dirtyBits),
            WA_DEFAULTS.IQ_TIMEOUT_MS,
            {
                count: dirtyBits.length
            }
        )
        runtime.logger.info('dirty bits cleared', {
            count: dirtyBits.length
        })
    } catch {
        return
    }
}
