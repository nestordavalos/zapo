/**
 * Low-level crypto primitives using WebCrypto API
 */

import { createHash, webcrypto } from 'node:crypto'

import { EMPTY_BYTES, toBytesView } from '@util/bytes'

/**
 * Re-exported CryptoKey type so consumers don't need to import from 'node:crypto'
 */
export type CryptoKey = webcrypto.CryptoKey

// ============================================
// Hash functions
// ============================================

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
    return toBytesView(await webcrypto.subtle.digest('SHA-256', value))
}

export async function sha512(value: Uint8Array): Promise<Uint8Array> {
    return toBytesView(await webcrypto.subtle.digest('SHA-512', value))
}

export function md5Bytes(input: string): Uint8Array {
    return toBytesView(createHash('md5').update(input).digest())
}

// ============================================
// AES-GCM (for Noise protocol)
// ============================================

export async function importAesGcmKey(
    raw: Uint8Array,
    usages: ('encrypt' | 'decrypt')[]
): Promise<webcrypto.CryptoKey> {
    return webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages)
}

export async function aesGcmEncrypt(
    key: webcrypto.CryptoKey,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array = EMPTY_BYTES
): Promise<Uint8Array> {
    const result = await webcrypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad },
        key,
        plaintext
    )
    return toBytesView(result)
}

export async function aesGcmDecrypt(
    key: webcrypto.CryptoKey,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    aad: Uint8Array = EMPTY_BYTES
): Promise<Uint8Array> {
    const result = await webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad },
        key,
        ciphertext
    )
    return toBytesView(result)
}

// ============================================
// AES-CBC (for Signal protocol)
// ============================================

export async function importAesCbcKey(keyBytes: Uint8Array): Promise<webcrypto.CryptoKey> {
    return webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC', length: 256 }, false, [
        'encrypt',
        'decrypt'
    ])
}

export async function aesCbcEncrypt(
    key: webcrypto.CryptoKey,
    iv: Uint8Array,
    plaintext: Uint8Array
): Promise<Uint8Array> {
    const result = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext)
    return toBytesView(result)
}

export async function aesCbcDecrypt(
    key: webcrypto.CryptoKey,
    iv: Uint8Array,
    ciphertext: Uint8Array
): Promise<Uint8Array> {
    const result = await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext)
    return toBytesView(result)
}

// ============================================
// HMAC-SHA256 (for Signal protocol)
// ============================================

export async function importHmacKey(keyBytes: Uint8Array): Promise<webcrypto.CryptoKey> {
    return webcrypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign'
    ])
}

export async function importHmacSha512Key(keyBytes: Uint8Array): Promise<webcrypto.CryptoKey> {
    return webcrypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, [
        'sign'
    ])
}

export async function hmacSign(key: webcrypto.CryptoKey, data: Uint8Array): Promise<Uint8Array> {
    return toBytesView(await webcrypto.subtle.sign('HMAC', key, data))
}

// ============================================
// PBKDF2 → AES-CTR (for pairing code crypto)
// ============================================

export async function pbkdf2DeriveAesCtrKey(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number
): Promise<CryptoKey> {
    const imported = await webcrypto.subtle.importKey('raw', password, { name: 'PBKDF2' }, false, [
        'deriveKey'
    ])
    return webcrypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt,
            iterations
        },
        imported,
        {
            name: 'AES-CTR',
            length: 256
        },
        false,
        ['encrypt', 'decrypt']
    )
}

// ============================================
// AES-CTR (for pairing code crypto)
// ============================================

export async function aesCtrEncrypt(
    key: CryptoKey,
    counter: Uint8Array,
    plaintext: Uint8Array
): Promise<Uint8Array> {
    const result = await webcrypto.subtle.encrypt(
        { name: 'AES-CTR', counter, length: 64 },
        key,
        plaintext
    )
    return toBytesView(result)
}

export async function aesCtrDecrypt(
    key: CryptoKey,
    counter: Uint8Array,
    ciphertext: Uint8Array
): Promise<Uint8Array> {
    const result = await webcrypto.subtle.decrypt(
        { name: 'AES-CTR', counter, length: 64 },
        key,
        ciphertext
    )
    return toBytesView(result)
}

// ============================================
// Ed25519 raw verify (for Signal variant sigs)
// ============================================

export async function ed25519VerifyRaw(
    publicKey: Uint8Array,
    signature: Uint8Array,
    message: Uint8Array
): Promise<boolean> {
    const cryptoKey = await webcrypto.subtle.importKey(
        'raw',
        publicKey,
        { name: 'Ed25519' },
        false,
        ['verify']
    )
    return webcrypto.subtle.verify('Ed25519', cryptoKey, signature, message)
}
