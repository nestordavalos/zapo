import { webcrypto } from 'node:crypto'

import { EMPTY_BYTES, TEXT_ENCODER, toBytesView } from '@util/bytes'

/**
 * HKDF key derivation using SHA-256
 */
export async function hkdf(
    ikm: Uint8Array,
    salt: Uint8Array | null,
    info: Uint8Array | string,
    outLength: number
): Promise<Uint8Array> {
    const key = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    const bits = await webcrypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: salt ?? EMPTY_BYTES,
            info: typeof info === 'string' ? TEXT_ENCODER.encode(info) : info
        },
        key,
        outLength * 8
    )
    return toBytesView(bits)
}

/**
 * HKDF key derivation that outputs two 32-byte keys
 */
export async function hkdfSplit(
    ikm: Uint8Array,
    salt: Uint8Array | null,
    info: string
): Promise<readonly [Uint8Array, Uint8Array]> {
    const out = await hkdf(ikm, salt, info, 64)
    return [out.subarray(0, 32), out.subarray(32, 64)]
}
