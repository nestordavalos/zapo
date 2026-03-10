import type { webcrypto } from 'node:crypto'

export type SubtleKeyPair = {
    privateKey: webcrypto.CryptoKey
    publicKey: webcrypto.CryptoKey
}
