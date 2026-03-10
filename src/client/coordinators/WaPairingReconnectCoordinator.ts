import type { WaAuthCredentials } from '../../auth/types'
import type { Logger } from '../../infra/log/types'
import type { WaComms } from '../../transport/WaComms'
import { toError } from '../../util/errors'

export interface WaPairingReconnectCoordinatorOptions {
    readonly logger: Logger
    readonly getCurrentCredentials: () => WaAuthCredentials | null
    readonly getComms: () => WaComms | null
    readonly stopKeepAlive: () => void
    readonly clearPendingQueries: (error: Error) => void
    readonly clearCommsBinding: () => void
    readonly startCommsWithCredentials: (credentials: WaAuthCredentials) => Promise<void>
    readonly onError: (error: Error) => void
}

export class WaPairingReconnectCoordinator {
    private readonly logger: Logger
    private readonly getCurrentCredentials: () => WaAuthCredentials | null
    private readonly getComms: () => WaComms | null
    private readonly stopKeepAlive: () => void
    private readonly clearPendingQueries: (error: Error) => void
    private readonly clearCommsBinding: () => void
    private readonly startCommsWithCredentials: (credentials: WaAuthCredentials) => Promise<void>
    private readonly onError: (error: Error) => void
    private reconnectPromise: Promise<void> | null

    public constructor(options: WaPairingReconnectCoordinatorOptions) {
        this.logger = options.logger
        this.getCurrentCredentials = options.getCurrentCredentials
        this.getComms = options.getComms
        this.stopKeepAlive = options.stopKeepAlive
        this.clearPendingQueries = options.clearPendingQueries
        this.clearCommsBinding = options.clearCommsBinding
        this.startCommsWithCredentials = options.startCommsWithCredentials
        this.onError = options.onError
        this.reconnectPromise = null
    }

    public scheduleReconnectAfterPairing(): void {
        this.logger.debug('wa client scheduling reconnect after pairing')
        setTimeout(() => {
            void this.reconnectAsRegisteredAfterPairing().catch((error) => {
                this.onError(toError(error))
            })
        }, 0)
    }

    public async reconnectAsRegisteredAfterPairing(): Promise<void> {
        if (this.reconnectPromise) {
            this.logger.trace('pairing reconnect already in-flight')
            return this.reconnectPromise
        }
        this.reconnectPromise = this.reconnectAsRegisteredAfterPairingInternal().finally(() => {
            this.reconnectPromise = null
        })
        return this.reconnectPromise
    }

    private async reconnectAsRegisteredAfterPairingInternal(): Promise<void> {
        const credentials = this.getCurrentCredentials()
        if (!credentials?.meJid) {
            this.logger.trace('pairing reconnect skipped: still unregistered')
            return
        }
        const currentComms = this.getComms()
        if (!currentComms) {
            this.logger.trace('pairing reconnect skipped: no active comms')
            return
        }

        this.logger.info('pairing completed, restarting comms as registered')
        this.stopKeepAlive()
        this.clearPendingQueries(new Error('restarting comms after pairing'))
        this.clearCommsBinding()
        try {
            await currentComms.stopComms()
        } catch (error) {
            this.logger.warn('failed to stop pre-registration comms', {
                message: toError(error).message
            })
        }
        await this.startCommsWithCredentials(credentials)
    }
}
