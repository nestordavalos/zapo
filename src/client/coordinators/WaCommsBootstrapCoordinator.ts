import type { WaAuthCredentials } from '../../auth/types'
import type { Logger } from '../../infra/log/types'
import type { WaCommsConfig } from '../../transport/types'
import { WaComms } from '../../transport/WaComms'

export interface WaCommsBootstrapCoordinatorOptions {
    readonly logger: Logger
    readonly buildCommsConfig: () => WaCommsConfig
    readonly setComms: (comms: WaComms | null) => void
    readonly clearMediaConnCache: () => void
    readonly bindComms: (comms: WaComms | null) => void
    readonly onIncomingFrame: (frame: Uint8Array) => Promise<void>
    readonly startKeepAlive: () => void
    readonly stopKeepAlive: () => void
    readonly persistServerStaticKey: (serverStaticKey: Uint8Array) => Promise<void>
    readonly startPassiveTasksAfterConnect: () => void
}

export class WaCommsBootstrapCoordinator {
    private readonly logger: Logger
    private readonly buildCommsConfig: () => WaCommsConfig
    private readonly setComms: (comms: WaComms | null) => void
    private readonly clearMediaConnCache: () => void
    private readonly bindComms: (comms: WaComms | null) => void
    private readonly onIncomingFrame: (frame: Uint8Array) => Promise<void>
    private readonly startKeepAlive: () => void
    private readonly stopKeepAlive: () => void
    private readonly persistServerStaticKey: (serverStaticKey: Uint8Array) => Promise<void>
    private readonly startPassiveTasksAfterConnect: () => void

    public constructor(options: WaCommsBootstrapCoordinatorOptions) {
        this.logger = options.logger
        this.buildCommsConfig = options.buildCommsConfig
        this.setComms = options.setComms
        this.clearMediaConnCache = options.clearMediaConnCache
        this.bindComms = options.bindComms
        this.onIncomingFrame = options.onIncomingFrame
        this.startKeepAlive = options.startKeepAlive
        this.stopKeepAlive = options.stopKeepAlive
        this.persistServerStaticKey = options.persistServerStaticKey
        this.startPassiveTasksAfterConnect = options.startPassiveTasksAfterConnect
    }

    public async startCommsWithCredentials(credentials: WaAuthCredentials): Promise<void> {
        this.logger.debug('starting comms with credentials', {
            registered: credentials.meJid !== null && credentials.meJid !== undefined
        })
        const commsConfig = this.buildCommsConfig()
        const comms = new WaComms(commsConfig, this.logger)
        this.setComms(comms)
        this.clearMediaConnCache()
        this.bindComms(comms)

        comms.startComms(async (frame) => this.onIncomingFrame(frame))
        await comms.waitForConnection(commsConfig.connectTimeoutMs)
        this.logger.info('comms connected')
        comms.startHandlingRequests()
        if (credentials.meJid) {
            this.startKeepAlive()
        } else {
            this.stopKeepAlive()
        }

        const serverStaticKey = comms.getServerStaticKey()
        if (!serverStaticKey) {
            this.logger.trace('no server static key available to persist')
        } else {
            await this.persistServerStaticKey(serverStaticKey)
            this.logger.debug('persisted server static key after comms connect')
        }
        this.startPassiveTasksAfterConnect()
    }
}
