import { webcrypto } from 'node:crypto'

import { toBytesView } from '../../util/bytes'

import { CORE_TEXT_ENCODER } from './constants'

const EMPTY_BYTES = new Uint8Array(0)

/**
 * HKDF key derivation using SHA-256
 */
export async function hkdf(
    ikm: Uint8Array,
    salt: Uint8Array | null,
    info: string,
    outLength: number
): Promise<Uint8Array> {
    const key = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    const bits = await webcrypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: salt ?? EMPTY_BYTES,
            info: CORE_TEXT_ENCODER.encode(info)
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
    info: string,
    salt: Uint8Array | null
): Promise<readonly [Uint8Array, Uint8Array]> {
    const out = await hkdf(ikm, salt, info, 64)
    return [out.subarray(0, 32), out.subarray(32, 64)]
}

/**
 * HKDF with raw bytes info (for sender key messages)
 */
export async function hkdfWithBytesInfo(
    ikmBytes: Uint8Array,
    infoBytes: Uint8Array,
    outputLength: number
): Promise<Uint8Array> {
    const ikm = await webcrypto.subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits'])
    const derivedBits = await webcrypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: EMPTY_BYTES,
            info: infoBytes
        },
        ikm,
        outputLength * 8
    )
    return toBytesView(derivedBits)
}
