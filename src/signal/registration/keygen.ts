import { randomInt } from 'node:crypto'

import { toSerializedPubKey } from '../../crypto/core/keys'
import type { X25519 } from '../../crypto/curves/X25519'
import type { WaAdvSignature } from '../crypto/WaAdvSignature'
import type { PreKeyRecord, RegistrationInfo, SignedPreKeyRecord } from '../types'

export async function generateRegistrationInfo(x25519: X25519): Promise<RegistrationInfo> {
    return {
        registrationId: await generateRegistrationId(),
        identityKeyPair: await x25519.generateKeyPair()
    }
}

export async function generatePreKeyPair(x25519: X25519, keyId: number): Promise<PreKeyRecord> {
    return {
        keyId,
        keyPair: await x25519.generateKeyPair(),
        uploaded: false
    }
}

export async function generateSignedPreKey(
    x25519: X25519,
    signalSignature: WaAdvSignature,
    keyId: number,
    signingPrivateKey: Uint8Array
): Promise<SignedPreKeyRecord> {
    const keyPair = await x25519.generateKeyPair()
    const serializedPubKey = toSerializedPubKey(keyPair.pubKey)
    const signature = await signalSignature.signSignalMessage(signingPrivateKey, serializedPubKey)
    return {
        keyId,
        keyPair,
        signature,
        uploaded: false
    }
}

export function generateRegistrationId(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        randomInt(1, 16_381, (error, value) => {
            if (error) {
                reject(error)
                return
            }
            resolve(value)
        })
    })
}
