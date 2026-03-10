import { webcrypto } from 'node:crypto'

import type { SignalKeyPair } from '../../auth/types'
import { toBytesView } from '../../util/bytes'
import { assert32, decodeBase64Url } from '../core/encoding'

import { X25519_PKCS8_PREFIX } from './constants'
import type { SubtleKeyPair } from './types'

export class X25519 {
    public async generateKeyPair(): Promise<SignalKeyPair> {
        const keys = (await webcrypto.subtle.generateKey({ name: 'X25519' }, true, [
            'deriveBits'
        ])) as SubtleKeyPair
        const privateJwk = await webcrypto.subtle.exportKey('jwk', keys.privateKey)
        return {
            pubKey: decodeBase64Url(privateJwk.x, 'x25519 public key'),
            privKey: decodeBase64Url(privateJwk.d, 'x25519 private key')
        }
    }

    public async keyPairFromPrivateKey(privKey: Uint8Array): Promise<SignalKeyPair> {
        assert32(privKey, 'x25519 private key')
        const privateKey = await webcrypto.subtle.importKey(
            'pkcs8',
            this.pkcs8FromRawPrivate(privKey),
            { name: 'X25519' },
            true,
            ['deriveBits']
        )
        const privateJwk = await webcrypto.subtle.exportKey('jwk', privateKey)
        return {
            pubKey: decodeBase64Url(privateJwk.x, 'x25519 public key'),
            privKey: decodeBase64Url(privateJwk.d, 'x25519 private key')
        }
    }

    public async scalarMult(privKey: Uint8Array, pubKey: Uint8Array): Promise<Uint8Array> {
        assert32(privKey, 'x25519 private key')
        assert32(pubKey, 'x25519 public key')

        const privateKey = await webcrypto.subtle.importKey(
            'pkcs8',
            this.pkcs8FromRawPrivate(privKey),
            { name: 'X25519' },
            false,
            ['deriveBits']
        )
        const publicKey = await webcrypto.subtle.importKey(
            'raw',
            pubKey,
            { name: 'X25519' },
            false,
            []
        )
        const sharedBits = await webcrypto.subtle.deriveBits(
            { name: 'X25519', public: publicKey },
            privateKey,
            256
        )
        return toBytesView(sharedBits)
    }

    private pkcs8FromRawPrivate(raw: Uint8Array): Uint8Array {
        const out = new Uint8Array(X25519_PKCS8_PREFIX.length + raw.length)
        out.set(X25519_PKCS8_PREFIX, 0)
        out.set(raw, X25519_PKCS8_PREFIX.length)
        return out
    }
}
