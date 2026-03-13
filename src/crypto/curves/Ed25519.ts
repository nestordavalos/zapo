import { webcrypto } from 'node:crypto'

import { assert32, decodeBase64Url } from '@crypto/core/encoding'
import { ED25519_PKCS8_PREFIX } from '@crypto/curves/constants'
import { pkcs8FromRawPrivate, type SignalKeyPair, type SubtleKeyPair } from '@crypto/curves/types'
import { toBytesView } from '@util/bytes'

export class Ed25519 {
    static async generateKeyPair(): Promise<SignalKeyPair> {
        const keys = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
            'sign',
            'verify'
        ])) as SubtleKeyPair
        const privateJwk = await webcrypto.subtle.exportKey('jwk', keys.privateKey)
        return {
            pubKey: decodeBase64Url(privateJwk.x, 'ed25519 public key'),
            privKey: decodeBase64Url(privateJwk.d, 'ed25519 private key')
        }
    }

    static async keyPairFromPrivateKey(privKey: Uint8Array): Promise<SignalKeyPair> {
        assert32(privKey, 'ed25519 private key')
        const privateKey = await webcrypto.subtle.importKey(
            'pkcs8',
            pkcs8FromRawPrivate(ED25519_PKCS8_PREFIX, privKey),
            { name: 'Ed25519' },
            true,
            ['sign']
        )
        const privateJwk = await webcrypto.subtle.exportKey('jwk', privateKey)
        return {
            pubKey: decodeBase64Url(privateJwk.x, 'ed25519 public key'),
            privKey: decodeBase64Url(privateJwk.d, 'ed25519 private key')
        }
    }

    static async sign(message: Uint8Array, privKey: Uint8Array): Promise<Uint8Array> {
        assert32(privKey, 'ed25519 private key')
        const privateKey = await webcrypto.subtle.importKey(
            'pkcs8',
            pkcs8FromRawPrivate(ED25519_PKCS8_PREFIX, privKey),
            { name: 'Ed25519' },
            false,
            ['sign']
        )
        const signature = await webcrypto.subtle.sign('Ed25519', privateKey, message)
        return toBytesView(signature)
    }

    static async verify(
        message: Uint8Array,
        signature: Uint8Array,
        pubKey: Uint8Array
    ): Promise<boolean> {
        assert32(pubKey, 'ed25519 public key')
        const publicKey = await webcrypto.subtle.importKey(
            'raw',
            pubKey,
            { name: 'Ed25519' },
            false,
            ['verify']
        )
        return webcrypto.subtle.verify('Ed25519', publicKey, signature, message)
    }
}
