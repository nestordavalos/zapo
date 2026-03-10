import type { WaAuthCredentials } from '../../auth/types'
import { randomBytesAsync } from '../../crypto'
import type { Logger } from '../../infra/log/types'
import { assertIqResult } from '../../transport/node/query'
import type { BinaryNode } from '../../transport/types'
import { toError } from '../../util/errors'
import {
    DIRTY_PROTOCOL_BLOCKLIST,
    DIRTY_PROTOCOL_DEVICES,
    DIRTY_PROTOCOL_NOTICE,
    DIRTY_PROTOCOL_PICTURE,
    DIRTY_PROTOCOL_PRIVACY,
    DIRTY_TYPE_ACCOUNT_SYNC,
    DIRTY_TYPE_GROUPS,
    DIRTY_TYPE_NEWSLETTER_METADATA,
    DIRTY_TYPE_SYNCD_APP_STATE,
    IQ_TIMEOUT_MS
} from '../constants'
import {
    buildAccountBlocklistSyncIq,
    buildAccountDevicesSyncIq,
    buildAccountPictureSyncIq,
    buildAccountPrivacySyncIq,
    buildGroupsDirtySyncIq,
    buildNewsletterMetadataSyncIq,
    resolveAccountSyncProtocols
} from '../sync/account'
import {
    buildClearDirtyBitsIq,
    parseDirtyBitNode,
    splitDirtyBitsBySupport
} from '../sync/dirty'
import type { WaDirtyBit } from '../sync/types'

type QueryWithContext = (
    context: string,
    node: BinaryNode,
    timeoutMs?: number,
    contextData?: Readonly<Record<string, unknown>>
) => Promise<BinaryNode>

export interface WaDirtySyncCoordinatorOptions {
    readonly logger: Logger
    readonly queryWithContext: QueryWithContext
    readonly getCurrentCredentials: () => WaAuthCredentials | null
    readonly syncAppState: () => Promise<void>
}

export class WaDirtySyncCoordinator {
    private readonly logger: Logger
    private readonly queryWithContext: QueryWithContext
    private readonly getCurrentCredentials: () => WaAuthCredentials | null
    private readonly syncAppState: () => Promise<void>

    public constructor(options: WaDirtySyncCoordinatorOptions) {
        this.logger = options.logger
        this.queryWithContext = options.queryWithContext
        this.getCurrentCredentials = options.getCurrentCredentials
        this.syncAppState = options.syncAppState
    }

    public parseDirtyBits(nodes: readonly BinaryNode[]): readonly WaDirtyBit[] {
        const dirtyBits: WaDirtyBit[] = []
        for (let index = 0; index < nodes.length; index += 1) {
            const parsedDirtyBit = parseDirtyBitNode(nodes[index], this.logger)
            if (parsedDirtyBit) {
                dirtyBits.push(parsedDirtyBit)
            }
        }
        return dirtyBits
    }

    public async handleDirtyBits(dirtyBits: readonly WaDirtyBit[]): Promise<void> {
        const { supported, unsupported } = splitDirtyBitsBySupport(dirtyBits)

        this.logger.info('handling dirty bits from info bulletin', {
            supported: supported.map((entry) => entry.type).join(','),
            unsupported: unsupported.map((entry) => entry.type).join(',')
        })

        await Promise.all(
            supported.map(async (dirtyBit) => {
                try {
                    await this.handleDirtyBit(dirtyBit)
                } catch (error) {
                    this.logger.warn('failed handling dirty bit', {
                        type: dirtyBit.type,
                        message: toError(error).message
                    })
                }
            })
        )

        await this.clearDirtyBits(unsupported.concat(supported))
    }

    private async handleDirtyBit(dirtyBit: WaDirtyBit): Promise<void> {
        switch (dirtyBit.type) {
            case DIRTY_TYPE_ACCOUNT_SYNC:
                await this.handleAccountSyncDirtyBit(dirtyBit.protocols)
                return
            case DIRTY_TYPE_SYNCD_APP_STATE:
                this.logger.info('received syncd_app_state dirty bit, starting sync')
                try {
                    await this.syncAppState()
                } catch (error) {
                    this.logger.warn('app-state sync failed after dirty bit', {
                        message: toError(error).message
                    })
                }
                return
            case DIRTY_TYPE_GROUPS:
                await this.syncGroupsDirtyBit()
                return
            case DIRTY_TYPE_NEWSLETTER_METADATA:
                await this.syncNewsletterMetadataDirtyBit()
                return
            default:
                this.logger.debug('received unsupported dirty bit', {
                    type: dirtyBit.type
                })
                return
        }
    }

    private async handleAccountSyncDirtyBit(protocols: readonly string[]): Promise<void> {
        const selectedProtocols = resolveAccountSyncProtocols(protocols)
        this.logger.info('received account_sync dirty bit', {
            protocols: selectedProtocols.join(',')
        })
        await Promise.all(
            selectedProtocols.map(async (protocol) => {
                try {
                    await this.runAccountSyncProtocol(protocol)
                } catch (error) {
                    this.logger.warn('account_sync protocol failed', {
                        protocol,
                        message: toError(error).message
                    })
                }
            })
        )
    }

    private async runAccountSyncProtocol(protocol: string): Promise<void> {
        switch (protocol) {
            case DIRTY_PROTOCOL_DEVICES:
                await this.syncAccountDevicesDirtyBit()
                return
            case DIRTY_PROTOCOL_PICTURE:
                await this.syncAccountPictureDirtyBit()
                return
            case DIRTY_PROTOCOL_PRIVACY:
                await this.syncAccountPrivacyDirtyBit()
                return
            case DIRTY_PROTOCOL_BLOCKLIST:
                await this.syncAccountBlocklistDirtyBit()
                return
            case DIRTY_PROTOCOL_NOTICE:
                await this.syncAccountNoticeDirtyBit()
                return
            default:
                this.logger.debug('unsupported account_sync protocol', {
                    protocol
                })
                return
        }
    }

    private async syncAccountDevicesDirtyBit(): Promise<void> {
        const credentials = this.getCurrentCredentials()
        if (!credentials?.meJid) {
            this.logger.warn('account_sync devices skipped: meJid is missing')
            return
        }

        const response = await this.queryWithContext(
            'account_sync.devices',
            buildAccountDevicesSyncIq(credentials.meJid, await this.generateUsyncSid()),
            IQ_TIMEOUT_MS,
            {
                meJid: credentials.meJid
            }
        )
        assertIqResult(response, 'account_sync.devices')
        this.logger.debug('account_sync devices synchronized', {
            meJid: credentials.meJid
        })
    }

    private async syncAccountPictureDirtyBit(): Promise<void> {
        const credentials = this.getCurrentCredentials()
        if (!credentials?.meJid) {
            this.logger.warn('account_sync picture skipped: meJid is missing')
            return
        }

        const response = await this.queryWithContext(
            'account_sync.picture',
            buildAccountPictureSyncIq(credentials.meJid),
            IQ_TIMEOUT_MS,
            {
                meJid: credentials.meJid
            }
        )
        assertIqResult(response, 'account_sync.picture')
        this.logger.debug('account_sync picture synchronized', {
            meJid: credentials.meJid
        })
    }

    private async syncAccountPrivacyDirtyBit(): Promise<void> {
        const response = await this.queryWithContext(
            'account_sync.privacy',
            buildAccountPrivacySyncIq(),
            IQ_TIMEOUT_MS
        )
        assertIqResult(response, 'account_sync.privacy')
        this.logger.debug('account_sync privacy synchronized')
    }

    private async syncAccountBlocklistDirtyBit(): Promise<void> {
        const response = await this.queryWithContext(
            'account_sync.blocklist',
            buildAccountBlocklistSyncIq(),
            IQ_TIMEOUT_MS
        )
        assertIqResult(response, 'account_sync.blocklist')
        this.logger.debug('account_sync blocklist synchronized')
    }

    private async syncAccountNoticeDirtyBit(): Promise<void> {
        this.logger.info('account_sync notice protocol received (no GraphQL/MEX job configured)')
    }

    private async syncGroupsDirtyBit(): Promise<void> {
        const response = await this.queryWithContext(
            'dirty.groups',
            buildGroupsDirtySyncIq(),
            IQ_TIMEOUT_MS
        )
        assertIqResult(response, 'groups')
        this.logger.debug('groups dirty sync completed')
    }

    private async syncNewsletterMetadataDirtyBit(): Promise<void> {
        this.logger.info('newsletter_metadata dirty bit received (GraphQL/MEX sync intentionally disabled)')
        await this.queryWithContext(
            'dirty.newsletter_metadata',
            buildNewsletterMetadataSyncIq(),
            IQ_TIMEOUT_MS
        ).catch(() => undefined)
    }

    private async generateUsyncSid(): Promise<string> {
        const seed = await randomBytesAsync(8)
        return Buffer.from(seed).toString('hex')
    }

    private async clearDirtyBits(dirtyBits: readonly WaDirtyBit[]): Promise<void> {
        try {
            await this.queryWithContext(
                'dirty.clear',
                buildClearDirtyBitsIq(dirtyBits),
                IQ_TIMEOUT_MS,
                {
                    count: dirtyBits.length
                }
            )
            this.logger.info('dirty bits cleared', {
                count: dirtyBits.length
            })
        } catch {
            return
        }
    }
}
