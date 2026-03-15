import assert from 'node:assert/strict'
import test from 'node:test'

import { Ed25519 } from '@crypto/curves/Ed25519'
import { clampCurvePrivateKeyInPlace, X25519 } from '@crypto/curves/X25519'

test('x25519 scalar multiplication is symmetric between peers', async () => {
    const alice = await X25519.generateKeyPair()
    const bob = await X25519.generateKeyPair()

    const sharedA = await X25519.scalarMult(alice.privKey, bob.pubKey)
    const sharedB = await X25519.scalarMult(bob.privKey, alice.pubKey)

    assert.deepEqual(sharedA, sharedB)
    assert.equal(sharedA.length, 32)
})

test('x25519 key derivation from private key is stable', async () => {
    const pair = await X25519.generateKeyPair()
    const derived = await X25519.keyPairFromPrivateKey(pair.privKey)

    assert.deepEqual(derived.privKey, pair.privKey)
    assert.deepEqual(derived.pubKey, pair.pubKey)

    const privateKey = new Uint8Array(32).fill(255)
    const clamped = clampCurvePrivateKeyInPlace(privateKey)
    assert.equal(clamped[0] & 0b111, 0)
    assert.equal(clamped[31] & 0b0100_0000, 0b0100_0000)
})

test('ed25519 signs and verifies messages', async () => {
    const pair = await Ed25519.generateKeyPair()
    const message = new Uint8Array([1, 2, 3, 4])

    const signature = await Ed25519.sign(message, pair.privKey)
    assert.equal(signature.length, 64)

    const verified = await Ed25519.verify(message, signature, pair.pubKey)
    assert.equal(verified, true)

    const notVerified = await Ed25519.verify(new Uint8Array([9]), signature, pair.pubKey)
    assert.equal(notVerified, false)
})
