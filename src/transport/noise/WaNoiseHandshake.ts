import { webcrypto } from 'node:crypto'

import { buildNonce, hkdfSplit64, importAesGcmKey, sha256 } from '@crypto'
import { EMPTY_BYTES } from '@transport/noise/constants'
import { WaNoiseSocket } from '@transport/noise/WaNoiseSocket'
import { concatBytes, toBytesView } from '@util/bytes'


export class WaNoiseHandshake {
    private handshakeHash: Uint8Array
    private chainingKey: Uint8Array
    private cipherKey: webcrypto.CryptoKey | null
    private nonce: number

    public constructor() {
        this.handshakeHash = EMPTY_BYTES
        this.chainingKey = EMPTY_BYTES
        this.cipherKey = null
        this.nonce = 0
    }

    public async start(protocolName: Uint8Array, prologue: Uint8Array): Promise<void> {
        const hashInput = protocolName.length === 32 ? protocolName : await sha256(protocolName)
        this.handshakeHash = hashInput
        this.chainingKey = hashInput
        this.cipherKey = await importAesGcmKey(this.handshakeHash, ['encrypt', 'decrypt'])
        await this.authenticate(prologue)
    }

    public async authenticate(data: Uint8Array): Promise<void> {
        this.handshakeHash = await sha256(concatBytes([this.handshakeHash, data]))
    }

    public async mixIntoKey(keyMaterial: Uint8Array): Promise<void> {
        this.nonce = 0
        const [newChainingKey, nextCipherKey] = await hkdfSplit64(this.chainingKey, keyMaterial)
        this.chainingKey = newChainingKey
        this.cipherKey = await importAesGcmKey(nextCipherKey, ['encrypt', 'decrypt'])
    }

    public async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
        if (!this.cipherKey) {
            throw new Error('noise handshake cipher key is not initialized')
        }
        const nonce = buildNonce(this.nonce++)
        const encrypted = await webcrypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: nonce,
                additionalData: this.handshakeHash
            },
            this.cipherKey,
            plaintext
        )
        const ciphertext = toBytesView(encrypted)
        await this.authenticate(ciphertext)
        return ciphertext
    }

    public async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
        if (!this.cipherKey) {
            throw new Error('noise handshake cipher key is not initialized')
        }
        const nonce = buildNonce(this.nonce++)
        const decrypted = await webcrypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: nonce,
                additionalData: this.handshakeHash
            },
            this.cipherKey,
            ciphertext
        )
        await this.authenticate(ciphertext)
        return toBytesView(decrypted)
    }

    public async finish(): Promise<WaNoiseSocket> {
        const [writeKeyRaw, readKeyRaw] = await hkdfSplit64(this.chainingKey, EMPTY_BYTES)
        const writeKey = await importAesGcmKey(writeKeyRaw, ['encrypt'])
        const readKey = await importAesGcmKey(readKeyRaw, ['decrypt'])
        return new WaNoiseSocket(writeKey, readKey)
    }
}
