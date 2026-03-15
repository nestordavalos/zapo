import assert from 'node:assert/strict'
import test from 'node:test'

import { APP_STATE_EMPTY_LT_HASH } from '@appstate/constants'
import {
    keyDeviceId,
    keyEpoch,
    parseCollectionName,
    pickActiveSyncKey,
    toNetworkOrder64
} from '@appstate/utils'
import { WaAppStateCrypto } from '@appstate/WaAppStateCrypto'
import { parseCollectionState, parseSyncResponse } from '@appstate/WaAppStateSyncResponseParser'
import { proto } from '@proto'
import {
    WA_APP_STATE_COLLECTIONS,
    WA_APP_STATE_COLLECTION_STATES,
    WA_APP_STATE_ERROR_CODES,
    WA_IQ_TYPES,
    WA_NODE_TAGS
} from '@protocol/constants'

test('appstate utils parse collection names, key metadata and active key ordering', () => {
    assert.equal(parseCollectionName(WA_APP_STATE_COLLECTIONS.REGULAR), WA_APP_STATE_COLLECTIONS.REGULAR)
    assert.equal(parseCollectionName('unknown'), null)

    const keyA = new Uint8Array([0, 2, 0, 0, 0, 1])
    const keyB = new Uint8Array([0, 1, 0, 0, 0, 2])

    assert.equal(keyDeviceId(keyA), 2)
    assert.equal(keyEpoch(keyA), 1)

    const active = pickActiveSyncKey([
        { keyId: keyA, keyData: new Uint8Array([1]), timestamp: 1 },
        { keyId: keyB, keyData: new Uint8Array([2]), timestamp: 2 }
    ])
    assert.deepEqual(active?.keyId, keyB)

    assert.deepEqual(toNetworkOrder64(0x1_0000_0002), new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2]))
})

test('appstate sync response parser decodes collection state, patches and references', () => {
    const patchBytes = proto.SyncdPatch.encode({}).finish()
    const snapshotBytes = proto.ExternalBlobReference.encode({
        directPath: '/snapshot',
        mediaKey: new Uint8Array([1]),
        fileSha256: new Uint8Array([2]),
        fileEncSha256: new Uint8Array([3])
    }).finish()

    const iqNode = {
        tag: 'iq',
        attrs: { type: 'result' },
        content: [
            {
                tag: WA_NODE_TAGS.SYNC,
                attrs: {},
                content: [
                    {
                        tag: WA_NODE_TAGS.COLLECTION,
                        attrs: {
                            name: WA_APP_STATE_COLLECTIONS.REGULAR,
                            version: '10'
                        },
                        content: [
                            {
                                tag: WA_NODE_TAGS.PATCHES,
                                attrs: {},
                                content: [{ tag: WA_NODE_TAGS.PATCH, attrs: {}, content: patchBytes }]
                            },
                            {
                                tag: WA_NODE_TAGS.SNAPSHOT,
                                attrs: {},
                                content: snapshotBytes
                            }
                        ]
                    }
                ]
            }
        ]
    }

    const payloads = parseSyncResponse(iqNode)
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].collection, WA_APP_STATE_COLLECTIONS.REGULAR)
    assert.equal(payloads[0].state, WA_APP_STATE_COLLECTION_STATES.SUCCESS)
    assert.equal(payloads[0].version, 10)
    assert.equal(payloads[0].patches.length, 1)
    assert.ok(payloads[0].snapshotReference)

    const conflictNode = {
        tag: WA_NODE_TAGS.COLLECTION,
        attrs: { type: WA_IQ_TYPES.ERROR },
        content: [{ tag: WA_NODE_TAGS.ERROR, attrs: { code: WA_APP_STATE_ERROR_CODES.CONFLICT } }]
    }
    assert.equal(parseCollectionState(conflictNode), WA_APP_STATE_COLLECTION_STATES.CONFLICT)
})

test('appstate crypto encrypts/decrypts mutation and computes hash transitions', async () => {
    const crypto = new WaAppStateCrypto()
    const keyId = new Uint8Array([0, 1, 2, 3, 4, 5])
    const keyData = new Uint8Array(32).fill(9)

    const encrypted = await crypto.encryptMutation({
        operation: proto.SyncdMutation.SyncdOperation.SET,
        keyId,
        keyData,
        index: 'chat:1',
        value: { timestamp: 123 },
        version: 1,
        iv: new Uint8Array(16).fill(1)
    })

    const decrypted = await crypto.decryptMutation({
        operation: proto.SyncdMutation.SyncdOperation.SET,
        keyId,
        keyData,
        indexMac: encrypted.indexMac,
        valueBlob: encrypted.valueBlob
    })

    assert.equal(decrypted.index, 'chat:1')
    assert.equal(decrypted.version, 1)

    const snapshotMac = await crypto.generateSnapshotMac(
        keyData,
        APP_STATE_EMPTY_LT_HASH,
        1,
        WA_APP_STATE_COLLECTIONS.REGULAR
    )
    const patchMac = await crypto.generatePatchMac(
        keyData,
        snapshotMac,
        [encrypted.valueMac],
        1,
        WA_APP_STATE_COLLECTIONS.REGULAR
    )

    assert.equal(snapshotMac.length > 0, true)
    assert.equal(patchMac.length > 0, true)

    const updated = await crypto.ltHashSubtractThenAdd(
        APP_STATE_EMPTY_LT_HASH,
        [encrypted.valueMac],
        []
    )
    assert.equal(updated.hash.length, APP_STATE_EMPTY_LT_HASH.length)
})
