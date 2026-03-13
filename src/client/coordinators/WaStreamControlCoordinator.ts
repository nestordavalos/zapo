import type { Logger } from '@infra/log/types'
import { handleParsedStreamControl } from '@transport/stream/handlers'
import type { WaStreamControlNodeResult } from '@transport/stream/parse'
import type { WaComms } from '@transport/WaComms'
import { toError } from '@util/primitives'

interface WaStreamControlCoordinatorOptions {
    readonly logger: Logger
    readonly getComms: () => WaComms | null
    readonly clearPendingQueries: (error: Error) => void
    readonly clearMediaConnCache: () => void
    readonly disconnect: () => Promise<void>
    readonly clearStoredCredentials: () => Promise<void>
    readonly connect: () => Promise<void>
}

export interface WaStreamControlHandler {
    readonly handleStreamControlResult: (result: WaStreamControlNodeResult) => Promise<void>
}

export function createStreamControlHandler(
    options: WaStreamControlCoordinatorOptions
): WaStreamControlHandler {
    const {
        logger,
        getComms,
        clearPendingQueries,
        clearMediaConnCache,
        disconnect,
        clearStoredCredentials,
        connect
    } = options

    let lifecyclePromise: Promise<void> | null = null

    const runStreamControlLifecycle = (
        reason: string,
        action: () => Promise<void>
    ): Promise<void> => {
        if (lifecyclePromise) {
            logger.debug('stream-control lifecycle already running', { reason })
            return lifecyclePromise
        }
        lifecyclePromise = action().finally(() => {
            lifecyclePromise = null
        })
        return lifecyclePromise
    }

    const restartBackendAfterStreamControl = async (reason: string): Promise<void> => {
        logger.info('restarting backend after stream control', { reason })
        try {
            await connect()
        } catch (error) {
            logger.warn('failed to restart backend after stream control', {
                reason,
                message: toError(error).message
            })
        }
    }

    const resumeSocketDueToStreamError = async (reason: string): Promise<void> => {
        const comms = getComms()
        if (!comms) {
            return
        }
        logger.info('resuming socket due to stream control node', { reason })
        clearPendingQueries(new Error(`socket resume requested by ${reason}`))
        clearMediaConnCache()
        try {
            await comms.closeSocketAndResume()
        } catch (error) {
            logger.warn('failed to resume socket for stream control node', {
                reason,
                message: toError(error).message
            })
        }
    }

    const forceLoginDueToStreamError = async (code: number): Promise<void> => {
        await runStreamControlLifecycle(`stream_error_code_${code}`, async () => {
            logger.warn('received forced login stream error; starting login lifecycle', {
                code
            })
            await disconnect()
            await clearStoredCredentials()
            await restartBackendAfterStreamControl(`stream_error_code_${code}`)
        })
    }

    const disconnectDueToStreamError = async (reason: string): Promise<void> => {
        await runStreamControlLifecycle(reason, async () => {
            logger.warn('disconnecting due to stream control node', { reason })
            await disconnect()
        })
    }

    const logoutDueToStreamError = async (
        reason: string,
        shouldRestartBackend: boolean
    ): Promise<void> => {
        await runStreamControlLifecycle(reason, async () => {
            logger.warn('logging out due to stream control node', {
                reason,
                shouldRestartBackend
            })
            await disconnect()
            await clearStoredCredentials()
            if (shouldRestartBackend) {
                await restartBackendAfterStreamControl(reason)
            }
        })
    }

    return {
        handleStreamControlResult: async (result: WaStreamControlNodeResult) =>
            handleParsedStreamControl(result, {
                logger,
                forceLoginDueToStreamError,
                logoutDueToStreamError,
                disconnectDueToStreamError,
                resumeSocketDueToStreamError
            })
    }
}
