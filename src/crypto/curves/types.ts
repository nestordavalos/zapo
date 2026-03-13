import type { webcrypto } from 'node:crypto'

export interface SignalKeyPair {
    readonly pubKey: Uint8Array
    readonly privKey: Uint8Array
}

export interface SubtleKeyPair {
    readonly privateKey: webcrypto.CryptoKey
    readonly publicKey: webcrypto.CryptoKey
}

export function pkcs8FromRawPrivate(prefix: Uint8Array, raw: Uint8Array): Uint8Array {
    const out = new Uint8Array(prefix.length + raw.length)
    out.set(prefix, 0)
    out.set(raw, prefix.length)
    return out
}
