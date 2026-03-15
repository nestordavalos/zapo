import assert from 'node:assert/strict'
import test from 'node:test'

import { WaIncomingNodeCoordinator } from '@client/coordinators/WaIncomingNodeCoordinator'
import { createStreamControlHandler } from '@client/coordinators/WaStreamControlCoordinator'
import type { Logger } from '@infra/log/types'
import { WA_STREAM_SIGNALING } from '@protocol/constants'

function createLogger(): Logger {
    return {
        level: 'trace',
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
    }
}

function createIncomingRuntime() {
    const unhandled: unknown[] = []
    return {
        runtime: {
            handleStreamControlResult: async () => undefined,
            persistSuccessAttributes: async () => undefined,
            emitSuccessNode: () => undefined,
            updateClockSkewFromSuccess: () => undefined,
            shouldWarmupMediaConn: () => false,
            warmupMediaConn: async () => undefined,
            persistRoutingInfo: async () => undefined,
            tryResolvePendingNode: () => false,
            handleGenericIncomingNode: async () => false,
            handleIncomingIqSetNode: async () => false,
            handleLinkCodeNotificationNode: async () => false,
            handleCompanionRegRefreshNotificationNode: async () => false,
            handleIncomingMessageNode: async () => false,
            sendNode: async () => undefined,
            handleIncomingRetryReceipt: async () => undefined,
            trackOutboundReceipt: async () => undefined,
            emitIncomingReceipt: () => undefined,
            emitIncomingPresence: () => undefined,
            emitIncomingChatstate: () => undefined,
            emitIncomingCall: () => undefined,
            emitIncomingFailure: () => undefined,
            emitIncomingErrorStanza: () => undefined,
            emitIncomingNotification: () => undefined,
            emitGroupEvent: () => undefined,
            emitUnhandledIncomingNode: (event: unknown) => {
                unhandled.push(event)
            },
            syncAppState: async () => undefined,
            disconnect: async () => undefined,
            clearStoredCredentials: async () => undefined,
            parseDirtyBits: () => [],
            handleDirtyBits: async () => undefined
        },
        unhandled
    }
}

test('incoming node coordinator supports dynamic handler registration and unregistration', async () => {
    const { runtime, unhandled } = createIncomingRuntime()
    const coordinator = new WaIncomingNodeCoordinator({
        logger: createLogger(),
        runtime
    })

    let handledCount = 0
    const handler = async () => {
        handledCount += 1
        return true
    }

    const unregister = coordinator.registerIncomingHandler({
        tag: 'custom',
        handler
    })

    await coordinator.handleIncomingNode({ tag: 'custom', attrs: {} })
    assert.equal(handledCount, 1)

    unregister()
    await coordinator.handleIncomingNode({ tag: 'custom', attrs: {} })
    assert.equal(handledCount, 1)
    assert.equal(unhandled.length, 1)
})

test('stream control handler runs force-login and resume flows', async () => {
    const calls: string[] = []
    const handler = createStreamControlHandler({
        logger: createLogger(),
        getComms: () => ({
            closeSocketAndResume: async () => {
                calls.push('resume')
            }
        }) as never,
        clearPendingQueries: () => {
            calls.push('clear_pending')
        },
        clearMediaConnCache: () => {
            calls.push('clear_media')
        },
        disconnect: async () => {
            calls.push('disconnect')
        },
        clearStoredCredentials: async () => {
            calls.push('clear_credentials')
        },
        connect: async () => {
            calls.push('connect')
        }
    })

    await handler.handleStreamControlResult({
        kind: 'stream_error_code',
        code: WA_STREAM_SIGNALING.FORCE_LOGIN_CODE
    })

    assert.deepEqual(calls, ['disconnect', 'clear_credentials', 'connect'])

    calls.length = 0
    await handler.handleStreamControlResult({
        kind: 'stream_error_code',
        code: 500
    })

    assert.deepEqual(calls, ['clear_pending', 'clear_media', 'resume'])
})
