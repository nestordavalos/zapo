import type { webcrypto } from 'node:crypto'

export interface SignalKeyPair {
    readonly pubKey: Uint8Array
    readonly privKey: Uint8Array
}

export type SubtleKeyPair = {
    privateKey: webcrypto.CryptoKey
    publicKey: webcrypto.CryptoKey
}
