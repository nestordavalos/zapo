import { webcrypto } from 'node:crypto'

import { buildNonce } from '@crypto'
import { EMPTY_AAD } from '@transport/noise/constants'
import { toBytesView } from '@util/bytes'

export class WaNoiseSocket {
    private readonly encryptKey: webcrypto.CryptoKey
    private readonly decryptKey: webcrypto.CryptoKey
    private writeCounter: number
    private readCounter: number

    public constructor(encryptKey: webcrypto.CryptoKey, decryptKey: webcrypto.CryptoKey) {
        this.encryptKey = encryptKey
        this.decryptKey = decryptKey
        this.writeCounter = 0
        this.readCounter = 0
    }

    public async encrypt(frame: Uint8Array, additionalData?: Uint8Array): Promise<Uint8Array> {
        const nonce = buildNonce(this.writeCounter++)
        const encrypted = await webcrypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: nonce,
                additionalData: additionalData ?? EMPTY_AAD
            },
            this.encryptKey,
            frame
        )
        return toBytesView(encrypted)
    }

    public async decrypt(frame: Uint8Array, additionalData?: Uint8Array): Promise<Uint8Array> {
        const nonce = buildNonce(this.readCounter++)
        const decrypted = await webcrypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: nonce,
                additionalData: additionalData ?? EMPTY_AAD
            },
            this.decryptKey,
            frame
        )
        return toBytesView(decrypted)
    }
}
