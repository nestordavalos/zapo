import { bytesToBigIntLE, bigIntToBytesLE } from '../math/le'
import { mod, modInv } from '../math/mod'

export function rawCurvePublicKey(publicKey: Uint8Array): Uint8Array {
    if (publicKey.length === 32) {
        return publicKey
    }
    if (publicKey.length === 33 && publicKey[0] === 5) {
        return publicKey.subarray(1)
    }
    throw new Error(`invalid curve25519 public key length ${publicKey.length}`)
}

export function clampCurvePrivateKey(privateKey: Uint8Array): Uint8Array {
    if (privateKey.length !== 32) {
        throw new Error(`invalid curve25519 private key length ${privateKey.length}`)
    }
    privateKey[0] &= 248
    privateKey[31] &= 127
    privateKey[31] |= 64
    return privateKey
}

export function montgomeryToEdwardsPublic(curvePublicKey: Uint8Array, signBit: number): Uint8Array {
    const x = bytesToBigIntLE(curvePublicKey)
    const y = mod((x - 1n) * modInv(x + 1n))
    const encoded = bigIntToBytesLE(y, 32)
    encoded[31] = (encoded[31] & 0x7f) | (signBit & 0x80)
    return encoded
}
