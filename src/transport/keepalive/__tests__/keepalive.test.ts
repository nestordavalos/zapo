import assert from 'node:assert/strict'
import test from 'node:test'

import type { Logger } from '@infra/log/types'
import { WaKeepAlive } from '@transport/keepalive/WaKeepAlive'

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

test('keepalive issues ping queries when connected and idle', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    let queryCount = 0
    const keepAlive = new WaKeepAlive({
        logger: createLogger(),
        nodeOrchestrator: {
            hasPending: () => false,
            query: async () => {
                queryCount += 1
                return { tag: 'iq', attrs: { type: 'result' } }
            }
        },
        getComms: () => ({
            getCommsState: () => ({ connected: true })
        }) as never,
        intervalMs: 5,
        timeoutMs: 5,
        jitterRatio: 0,
        minJitterMs: 0
    })

    keepAlive.start()
    t.mock.timers.tick(5)
    await Promise.resolve()
    await Promise.resolve()
    keepAlive.stop()

    assert.ok(queryCount >= 1)
})

test('keepalive asks comms to resume when ping fails', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })

    let resumed = 0
    const keepAlive = new WaKeepAlive({
        logger: createLogger(),
        nodeOrchestrator: {
            hasPending: () => false,
            query: async () => {
                throw new Error('timeout')
            }
        },
        getComms: () => ({
            getCommsState: () => ({ connected: true }),
            closeSocketAndResume: async () => {
                resumed += 1
            }
        }) as never,
        intervalMs: 5,
        timeoutMs: 5,
        jitterRatio: 0,
        minJitterMs: 0
    })

    keepAlive.start()
    t.mock.timers.tick(5)
    await Promise.resolve()
    await Promise.resolve()
    keepAlive.stop()

    assert.ok(resumed >= 1)
})
