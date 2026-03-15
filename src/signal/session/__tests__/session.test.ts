import assert from 'node:assert/strict'
import test from 'node:test'

import { prependVersion } from '@crypto'
import type { Logger } from '@infra/log/types'
import { proto } from '@proto'
import { SIGNAL_MAC_SIZE, SIGNAL_VERSION } from '@signal/constants'
import {
    generatePreKeyPair,
    generateRegistrationInfo,
    generateSignedPreKey
} from '@signal/registration/keygen'
import { SignalProtocol } from '@signal/session/SignalProtocol'
import { deriveMsgKey, selectMessageKey } from '@signal/session/SignalRatchet'
import {
    deserializeMsg,
    deserializePkMsg,
    requirePreKey,
    requireSignedPreKey
} from '@signal/session/SignalSerializer'
import type { SignalAddress, SignalRecvChain } from '@signal/types'
import { WaSignalMemoryStore } from '@store/providers/memory/signal.store'
import { concatBytes } from '@util/bytes'

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

function makeBytes(length: number, seed = 0): Uint8Array {
    const out = new Uint8Array(length)
    for (let index = 0; index < out.length; index += 1) {
        out[index] = (seed + index) & 0xff
    }
    return out
}

function makeAddress(user: string): SignalAddress {
    return {
        user,
        server: 's.whatsapp.net',
        device: 0
    }
}

function createSignalMsgEnvelope(counter = 0): Uint8Array {
    const signalBody = proto.SignalMessage.encode({
        ratchetKey: makeBytes(32, 1),
        counter,
        previousCounter: 0,
        ciphertext: makeBytes(16, 2)
    }).finish()
    const versioned = prependVersion(signalBody, SIGNAL_VERSION)
    return concatBytes([versioned, makeBytes(SIGNAL_MAC_SIZE, 3)])
}

test('signal serializer parses signal and prekey-signal envelopes', () => {
    const msgEnvelope = createSignalMsgEnvelope(7)
    const parsed = deserializeMsg(msgEnvelope)
    assert.equal(parsed.counter, 7)
    assert.equal(parsed.ratchetPubKey.length, 33)
    assert.equal(parsed.ciphertext.length, 16)

    const preKeyBody = proto.PreKeySignalMessage.encode({
        registrationId: 123,
        preKeyId: 5,
        signedPreKeyId: 6,
        baseKey: makeBytes(32, 20),
        identityKey: makeBytes(32, 21),
        message: msgEnvelope
    }).finish()
    const preKeyEnvelope = prependVersion(preKeyBody, SIGNAL_VERSION)
    const parsedPreKey = deserializePkMsg(preKeyEnvelope)
    assert.equal(parsedPreKey.remote.regId, 123)
    assert.equal(parsedPreKey.localSignedPreKeyId, 6)
    assert.equal(parsedPreKey.localOneTimeKeyId, 5)
    assert.equal(parsedPreKey.sessionBaseKey.length, 33)
})

test('signal serializer key loaders require signed and one-time prekeys from store', async () => {
    const store = new WaSignalMemoryStore()
    const registration = await generateRegistrationInfo()
    await store.setRegistrationInfo(registration)

    const signed = await generateSignedPreKey(10, registration.identityKeyPair.privKey)
    const oneTime = await generatePreKeyPair(77)
    await store.setSignedPreKey(signed)
    await store.putPreKey(oneTime)

    const loadedSigned = await requireSignedPreKey(store, 10)
    const loadedPreKey = await requirePreKey(store, 77)
    assert.equal(loadedSigned.keyId, 10)
    assert.equal(loadedPreKey.keyId, 77)

    await assert.rejects(() => requireSignedPreKey(store, 11), /signed prekey 11 not found/)
    await assert.rejects(() => requirePreKey(store, 78), /prekey 78 not found/)
})

test('signal ratchet derives keys, selects future message keys and rejects duplicates', async () => {
    const chainKey = makeBytes(32, 40)
    const derived = await deriveMsgKey(0, chainKey)
    assert.equal(derived.nextChainKey.length, 32)
    assert.equal(derived.messageKey.cipherKey.length, 32)
    assert.equal(derived.messageKey.macKey.length, 32)
    assert.equal(derived.messageKey.iv.length, 16)

    const chain: SignalRecvChain = {
        ratchetPubKey: makeBytes(33, 70),
        nextMsgIndex: 0,
        chainKey,
        unusedMsgKeys: []
    }
    const future = await selectMessageKey(chain, 2)
    assert.equal(future.messageKey.index, 2)
    assert.equal(future.updatedChain.nextMsgIndex, 3)
    assert.ok(future.updatedChain.unusedMsgKeys.length > 0)

    const stale = await selectMessageKey(future.updatedChain, 1)
    assert.equal(stale.messageKey.index, 1)
    await assert.rejects(() => selectMessageKey(stale.updatedChain, 1), /duplicate message/)
    await assert.rejects(() => selectMessageKey(chain, 5_000), /message too far in future/)
})

test('signal protocol establishes outgoing session and decrypts prekey message on receiver', async () => {
    const logger = createLogger()
    const aliceStore = new WaSignalMemoryStore()
    const bobStore = new WaSignalMemoryStore()

    const [aliceRegistration, bobRegistration] = await Promise.all([
        generateRegistrationInfo(),
        generateRegistrationInfo()
    ])
    await aliceStore.setRegistrationInfo(aliceRegistration)
    await bobStore.setRegistrationInfo(bobRegistration)

    const bobSignedPreKey = await generateSignedPreKey(1, bobRegistration.identityKeyPair.privKey)
    const bobOneTimePreKey = await generatePreKeyPair(9)
    await bobStore.setSignedPreKey(bobSignedPreKey)
    await bobStore.putPreKey(bobOneTimePreKey)

    const aliceProtocol = new SignalProtocol(aliceStore, logger)
    const bobProtocol = new SignalProtocol(bobStore, logger)
    const aliceAddress = makeAddress('5511000000001')
    const bobAddress = makeAddress('5511000000002')

    await aliceProtocol.establishOutgoingSession(bobAddress, {
        regId: bobRegistration.registrationId,
        identity: bobRegistration.identityKeyPair.pubKey,
        signedKey: {
            id: bobSignedPreKey.keyId,
            publicKey: bobSignedPreKey.keyPair.pubKey,
            signature: bobSignedPreKey.signature
        },
        oneTimeKey: {
            id: bobOneTimePreKey.keyId,
            publicKey: bobOneTimePreKey.keyPair.pubKey
        }
    })

    const plaintext = makeBytes(25, 5)
    const encrypted = await aliceProtocol.encryptMessage(
        bobAddress,
        plaintext,
        bobRegistration.identityKeyPair.pubKey
    )
    assert.equal(encrypted.type, 'pkmsg')
    assert.ok(encrypted.baseKey)

    const decrypted = await bobProtocol.decryptMessage(aliceAddress, {
        type: encrypted.type,
        ciphertext: encrypted.ciphertext
    })
    assert.deepEqual(decrypted, plaintext)
    assert.equal(await bobStore.getPreKeyById(bobOneTimePreKey.keyId), null)

    await assert.rejects(
        () => aliceProtocol.encryptMessage(bobAddress, plaintext, makeBytes(32, 99)),
        /identity mismatch/
    )
})

test('signal protocol throws when decrypting msg without an existing session', async () => {
    const store = new WaSignalMemoryStore()
    const registration = await generateRegistrationInfo()
    await store.setRegistrationInfo(registration)

    const protocol = new SignalProtocol(store, createLogger())
    await assert.rejects(
        () =>
            protocol.decryptMessage(makeAddress('5511000000009'), {
                type: 'msg',
                ciphertext: createSignalMsgEnvelope(1)
            }),
        /signal session not found/
    )
})
