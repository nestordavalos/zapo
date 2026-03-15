import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMediaMessageContent, getMediaConn } from '@client/messages'
import type { Logger } from '@infra/log/types'
import { parseMediaConnResponse } from '@media/conn'
import { WaMediaCrypto } from '@media/WaMediaCrypto'
import type { BinaryNode } from '@transport/types'

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

test('media conn parser validates hosts/auth and ttl semantics', () => {
    const now = 1_000
    const response: BinaryNode = {
        tag: 'iq',
        attrs: { type: 'result' },
        content: [
            {
                tag: 'media_conn',
                attrs: { auth: 'token', ttl: '60' },
                content: [
                    { tag: 'host', attrs: { hostname: 'mmg.whatsapp.net' }, content: undefined },
                    {
                        tag: 'host',
                        attrs: { hostname: 'fallback.host', type: 'fallback' },
                        content: undefined
                    }
                ]
            }
        ]
    }

    const parsed = parseMediaConnResponse(response, now)
    assert.equal(parsed.auth, 'token')
    assert.equal(parsed.hosts.length, 2)
    assert.equal(parsed.expiresAtMs, now + 60_000)

    assert.throws(
        () => parseMediaConnResponse({ tag: 'iq', attrs: { type: 'result' } }, now),
        /missing media_conn node/
    )
})

test('media crypto encrypt/decrypt bytes round-trip and hash validation', async () => {
    const mediaKey = await WaMediaCrypto.generateMediaKey()
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6])

    const encrypted = await WaMediaCrypto.encryptBytes('image', mediaKey, plaintext)
    assert.ok(encrypted.ciphertextHmac.length > plaintext.length)

    const decrypted = await WaMediaCrypto.decryptBytes(
        'image',
        mediaKey,
        encrypted.ciphertextHmac,
        encrypted.fileSha256,
        encrypted.fileEncSha256
    )
    assert.deepEqual(decrypted.plaintext, plaintext)

    await assert.rejects(
        () =>
            WaMediaCrypto.decryptBytes('image', mediaKey, encrypted.ciphertextHmac, new Uint8Array(32)),
        /plaintext file hash mismatch/
    )
})

test('media message builder supports text passthrough and conn caching', async () => {
    const logger = createLogger()
    let cache: {
        auth: string
        expiresAtMs: number
        hosts: readonly { hostname: string; isFallback: boolean }[]
    } | null = null
    let queryCount = 0

    const asMessage = await buildMediaMessageContent(
        {
            logger,
            mediaTransfer: {} as never,
            queryWithContext: async () => {
                throw new Error('not used')
            },
            getMediaConnCache: () => cache,
            setMediaConnCache: (value) => {
                cache = value
            }
        },
        'hello'
    )
    assert.equal(asMessage.conversation, 'hello')

    const fetched = await getMediaConn(
        {
            logger,
            mediaTransfer: {} as never,
            queryWithContext: async () => {
                queryCount += 1
                return {
                    tag: 'iq',
                    attrs: { type: 'result' },
                    content: [
                        {
                            tag: 'media_conn',
                            attrs: { auth: 'token', ttl: '120' },
                            content: [{ tag: 'host', attrs: { hostname: 'mmg.whatsapp.net' } }]
                        }
                    ]
                }
            },
            getMediaConnCache: () => cache,
            setMediaConnCache: (value) => {
                cache = value
            }
        },
        false
    )
    assert.equal(fetched.auth, 'token')

    const cached = await getMediaConn(
        {
            logger,
            mediaTransfer: {} as never,
            queryWithContext: async () => {
                queryCount += 1
                throw new Error('should not fetch when cache is fresh')
            },
            getMediaConnCache: () => cache,
            setMediaConnCache: (value) => {
                cache = value
            }
        },
        false
    )

    assert.equal(cached.auth, 'token')
    assert.equal(queryCount, 1)
})
