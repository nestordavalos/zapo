import assert from 'node:assert/strict'
import test from 'node:test'

import { WA_APP_STATE_COLLECTIONS } from '@protocol/constants'
import { WaAppStateMemoryStore } from '@store/providers/memory/appstate.store'
import { WaDeviceListMemoryStore } from '@store/providers/memory/device-list.store'
import { WaMessageMemoryStore } from '@store/providers/memory/message.store'
import { WaRetryMemoryStore } from '@store/providers/memory/retry.store'
import { SenderKeyMemoryStore } from '@store/providers/memory/sender-key.store'
import { WaSignalMemoryStore } from '@store/providers/memory/signal.store'
import { WaThreadMemoryStore } from '@store/providers/memory/thread.store'

test('memory message/thread stores enforce limits and ordering', async () => {
    const messageStore = new WaMessageMemoryStore({ maxMessages: 2 })
    await messageStore.upsert({ id: 'm1', threadJid: 't1', fromMe: true, timestampMs: 10 })
    await messageStore.upsert({ id: 'm2', threadJid: 't1', fromMe: true, timestampMs: 20 })
    await messageStore.upsert({ id: 'm3', threadJid: 't1', fromMe: true, timestampMs: 30 })

    assert.equal(await messageStore.getById('m1'), null)
    const list = await messageStore.listByThread('t1', 2)
    assert.deepEqual(
        list.map((entry) => entry.id),
        ['m3', 'm2']
    )

    const threadStore = new WaThreadMemoryStore({ maxThreads: 1 })
    await threadStore.upsert({ jid: 'a', unreadCount: 1 })
    await threadStore.upsert({ jid: 'b', unreadCount: 2 })
    assert.equal(await threadStore.getByJid('a'), null)
    assert.ok(await threadStore.getByJid('b'))
})

test('memory retry/device-list stores expire entries and support cleanup', async () => {
    const retryStore = new WaRetryMemoryStore(50)
    await retryStore.upsertOutboundMessage({
        messageId: 'id-1',
        toJid: 'to',
        messageType: 'text',
        replayMode: 'plaintext',
        replayPayload: new Uint8Array([1]),
        state: 'pending',
        createdAtMs: 1,
        updatedAtMs: 1,
        expiresAtMs: 5
    })
    const count = await retryStore.incrementInboundCounter('id-1', 'requester', 0, 5)
    assert.equal(count, 1)
    assert.equal(await retryStore.cleanupExpired(10), 2)
    await retryStore.destroy()

    const deviceListStore = new WaDeviceListMemoryStore(10, { maxUsers: 1 })
    await deviceListStore.upsertUserDevices({
        userJid: 'u1@s.whatsapp.net',
        deviceJids: ['u1:1@s.whatsapp.net'],
        updatedAtMs: 0
    })
    await deviceListStore.upsertUserDevices({
        userJid: 'u2@s.whatsapp.net',
        deviceJids: ['u2:1@s.whatsapp.net'],
        updatedAtMs: 0
    })

    assert.equal(await deviceListStore.getUserDevices('u1@s.whatsapp.net', 0), null)
    assert.ok(await deviceListStore.getUserDevices('u2@s.whatsapp.net', 0))
    await deviceListStore.destroy()
})

test('memory signal/sender-key/appstate stores cover key workflows', async () => {
    const signalStore = new WaSignalMemoryStore({ maxPreKeys: 4 })
    const generated = await signalStore.getOrGenPreKeys(2, async (keyId) => ({
        keyId,
        keyPair: {
            pubKey: new Uint8Array(32).fill(keyId),
            privKey: new Uint8Array(32).fill(keyId + 1)
        },
        uploaded: false
    }))

    assert.equal(generated.length, 2)
    await signalStore.markKeyAsUploaded(generated[1].keyId)
    assert.equal(await signalStore.getServerHasPreKeys(), false)
    await signalStore.setServerHasPreKeys(true)
    assert.equal(await signalStore.getServerHasPreKeys(), true)

    const senderKeyStore = new SenderKeyMemoryStore({
        maxSenderKeys: 10,
        maxSenderDistributions: 10
    })
    await senderKeyStore.upsertSenderKey({
        groupId: 'g1',
        sender: { user: 'u', server: 's.whatsapp.net', device: 1 },
        keyId: 1,
        iteration: 0,
        chainKey: new Uint8Array(32),
        signingPublicKey: new Uint8Array(33)
    })
    const senderKey = await senderKeyStore.getDeviceSenderKey('g1', {
        user: 'u',
        server: 's.whatsapp.net',
        device: 1
    })
    assert.ok(senderKey)

    const appStateStore = new WaAppStateMemoryStore(undefined, {
        maxSyncKeys: 10,
        maxCollectionEntries: 10
    })
    const inserted = await appStateStore.upsertSyncKeys([
        {
            keyId: new Uint8Array([0, 1, 0, 0, 0, 1]),
            keyData: new Uint8Array([9]),
            timestamp: 1
        }
    ])
    assert.equal(inserted, 1)

    await appStateStore.setCollectionStates([
        {
            collection: WA_APP_STATE_COLLECTIONS.REGULAR,
            version: 2,
            hash: new Uint8Array(128),
            indexValueMap: new Map([['a', new Uint8Array([1])]])
        }
    ])
    const state = await appStateStore.getCollectionState(WA_APP_STATE_COLLECTIONS.REGULAR)
    assert.equal(state.version, 2)
})
