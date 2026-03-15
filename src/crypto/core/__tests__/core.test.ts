import assert from 'node:assert/strict'
import test from 'node:test'

import { assert32, decodeBase64Url } from '@crypto/core/encoding'
import { hkdf, hkdfSplit } from '@crypto/core/hkdf'
import {
    prependVersion,
    readVersionedContent,
    toRawPubKey,
    toSerializedPubKey,
    versionByte
} from '@crypto/core/keys'
import { buildNonce } from '@crypto/core/nonce'
import {
    aesGcmDecrypt,
    aesGcmEncrypt,
    hmacSign,
    importAesGcmKey,
    importHmacKey,
    md5Bytes,
    sha256
} from '@crypto/core/primitives'
import { randomBytesAsync, randomIntAsync } from '@crypto/core/random'
import { bytesToBase64UrlSafe } from '@util/bytes'

test('hkdf derivation and split are deterministic with same inputs', async () => {
    const ikm = new Uint8Array(32).fill(1)
    const salt = new Uint8Array(32).fill(2)

    const one = await hkdf(ikm, salt, 'info', 32)
    const two = await hkdf(ikm, salt, 'info', 32)
    assert.deepEqual(one, two)
    assert.equal(one.length, 32)

    const [left, right] = await hkdfSplit(ikm, salt, 'split-info')
    assert.equal(left.length, 32)
    assert.equal(right.length, 32)
    assert.notDeepEqual(left, right)
})

test('nonce and versioned key helpers enforce protocol constraints', () => {
    assert.deepEqual(buildNonce(0x0102_0304), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]))
    assert.throws(() => buildNonce(0x1_0000_0000), /nonce counter overflow/)

    const raw = new Uint8Array(32).fill(7)
    const serialized = toSerializedPubKey(raw)
    assert.equal(serialized.length, 33)
    assert.deepEqual(toRawPubKey(serialized), raw)

    assert.equal(versionByte(5, 3), 0x53)
    const payload = new Uint8Array([8, 9, 10])
    const wrapped = prependVersion(payload, 3)
    assert.deepEqual(readVersionedContent(wrapped, 3, 0), payload)
    assert.throws(() => readVersionedContent(new Uint8Array([]), 3, 0), /is empty/)
})

test('primitive crypto functions encrypt/decrypt and sign deterministically', async () => {
    const keyRaw = new Uint8Array(32).fill(4)
    const key = await importAesGcmKey(keyRaw, ['encrypt', 'decrypt'])
    const nonce = new Uint8Array(12).fill(5)
    const plaintext = new Uint8Array([1, 2, 3, 4, 5])

    const ciphertext = await aesGcmEncrypt(key, nonce, plaintext)
    const decrypted = await aesGcmDecrypt(key, nonce, ciphertext)
    assert.deepEqual(decrypted, plaintext)

    const hmacKey = await importHmacKey(new Uint8Array(32).fill(6))
    const sig1 = await hmacSign(hmacKey, new Uint8Array([1, 2]))
    const sig2 = await hmacSign(hmacKey, new Uint8Array([1, 2]))
    assert.deepEqual(sig1, sig2)

    const digest = await sha256(new Uint8Array([7]))
    assert.equal(digest.length, 32)
    assert.equal(md5Bytes('abc').length, 16)
})

test('encoding and random helpers are compatible with URL-safe payloads', async () => {
    const raw = new Uint8Array(32).fill(12)
    const encoded = bytesToBase64UrlSafe(raw)
    const decoded = decodeBase64Url(encoded, 'field')
    assert.deepEqual(decoded, raw)

    assert.doesNotThrow(() => assert32(raw, 'x'))
    assert.throws(() => assert32(new Uint8Array(31), 'x'), /must be 32 bytes/)

    const randomBytes = await randomBytesAsync(24)
    assert.equal(randomBytes.length, 24)

    const randomInt = await randomIntAsync(1, 3)
    assert.ok(randomInt >= 1 && randomInt < 3)
})
