import type { WaAuthCredentials } from '@auth/types'
import type { Logger } from '@infra/log/types'
import { WA_DEFAULTS } from '@protocol/constants'
import { SIGNAL_UPLOAD_PREKEYS_COUNT } from '@signal/api/constants'
import { buildPreKeyUploadIq, parsePreKeyUploadFailure } from '@signal/api/prekeys'
import { generatePreKeyPair } from '@signal/registration/keygen'
import type { WaSignalStore } from '@store/contracts/signal.store'
import type { BinaryNode } from '@transport/types'
import { toError } from '@util/primitives'

type WaPassiveTasksRuntime = {
    readonly queryWithContext: (
        context: string,
        node: BinaryNode,
        timeoutMs?: number,
        contextData?: Readonly<Record<string, unknown>>
    ) => Promise<BinaryNode>
    readonly getCurrentCredentials: () => WaAuthCredentials | null
    readonly persistServerHasPreKeys: (serverHasPreKeys: boolean) => Promise<void>
    readonly sendNodeDirect: (node: BinaryNode) => Promise<void>
    readonly takeDanglingReceipts: () => BinaryNode[]
    readonly requeueDanglingReceipt: (node: BinaryNode) => void
    readonly shouldQueueDanglingReceipt: (node: BinaryNode, error: Error) => boolean
}

export class WaPassiveTasksCoordinator {
    private readonly logger: Logger
    private readonly signalStore: WaSignalStore
    private readonly runtime: WaPassiveTasksRuntime
    private passiveTasksPromise: Promise<void> | null

    public constructor(options: {
        readonly logger: Logger
        readonly signalStore: WaSignalStore
        readonly runtime: WaPassiveTasksRuntime
    }) {
        this.logger = options.logger
        this.signalStore = options.signalStore
        this.runtime = options.runtime
        this.passiveTasksPromise = null
    }

    public startPassiveTasksAfterConnect(): void {
        if (this.passiveTasksPromise) {
            this.logger.trace('passive connect tasks already running')
            return
        }
        this.passiveTasksPromise = this.runPassiveTasksAfterConnect()
            .catch((error) => {
                this.logger.warn('passive connect tasks failed', {
                    message: toError(error).message
                })
            })
            .finally(() => {
                this.passiveTasksPromise = null
            })
    }

    public resetInFlightState(): void {
        if (!this.passiveTasksPromise) {
            return
        }
        this.logger.trace('passive connect tasks reset requested while run is still in-flight')
    }

    private async runPassiveTasksAfterConnect(): Promise<void> {
        const credentials = this.runtime.getCurrentCredentials()
        const isRegistered = credentials?.meJid !== null && credentials?.meJid !== undefined
        if (!isRegistered) {
            this.logger.trace('passive connect tasks skipped: session is not registered')
            return
        }

        await this.uploadPreKeysIfMissing()
        await this.flushDanglingReceipts()
    }

    private async uploadPreKeysIfMissing(): Promise<void> {
        const serverHasPreKeys = await this.signalStore.getServerHasPreKeys()
        if (serverHasPreKeys) {
            this.logger.trace('prekey upload skipped: server already has prekeys')
            return
        }

        const registrationInfo = await this.signalStore.getRegistrationInfo()
        const signedPreKey = await this.signalStore.getSignedPreKey()
        if (!registrationInfo || !signedPreKey) {
            this.logger.warn('prekey upload skipped: registration info is missing')
            return
        }

        const preKeys = await this.signalStore.getOrGenPreKeys(
            SIGNAL_UPLOAD_PREKEYS_COUNT,
            generatePreKeyPair
        )
        if (preKeys.length === 0) {
            throw new Error('no prekey available for upload')
        }

        const lastPreKeyId = preKeys[preKeys.length - 1].keyId
        const uploadNode = buildPreKeyUploadIq(registrationInfo, signedPreKey, preKeys)
        const response = await this.runtime.queryWithContext(
            'prekeys.upload',
            uploadNode,
            WA_DEFAULTS.IQ_TIMEOUT_MS,
            {
                count: preKeys.length,
                lastPreKeyId
            }
        )
        if (response.attrs.type === 'result') {
            await this.signalStore.markKeyAsUploaded(lastPreKeyId)
            await this.signalStore.setServerHasPreKeys(true)
            await this.runtime.persistServerHasPreKeys(true)
            this.logger.info('uploaded prekeys to server', {
                count: preKeys.length,
                lastPreKeyId
            })
            return
        }

        const failure = parsePreKeyUploadFailure(response)
        this.logger.warn('upload prekeys failed', {
            count: preKeys.length,
            errorCode: failure.errorCode,
            errorText: failure.errorText
        })
    }

    private async flushDanglingReceipts(): Promise<void> {
        const pending = this.runtime.takeDanglingReceipts()
        if (pending.length === 0) {
            return
        }

        this.logger.info('flushing dangling receipts', { count: pending.length })
        for (let index = 0; index < pending.length; index += 1) {
            const node = pending[index]
            try {
                await this.runtime.sendNodeDirect(node)
            } catch (error) {
                const normalized = toError(error)
                if (this.runtime.shouldQueueDanglingReceipt(node, normalized)) {
                    for (
                        let restoreIndex = index;
                        restoreIndex < pending.length;
                        restoreIndex += 1
                    ) {
                        this.runtime.requeueDanglingReceipt(pending[restoreIndex])
                    }
                    this.logger.warn('stopped dangling receipt flush due transient send error', {
                        remaining: pending.length - index,
                        message: normalized.message
                    })
                    return
                }
                this.logger.warn('dropping dangling receipt due non-retryable send error', {
                    id: node.attrs.id,
                    to: node.attrs.to,
                    message: normalized.message
                })
            }
        }
        this.logger.info('dangling receipts flushed')
    }
}
