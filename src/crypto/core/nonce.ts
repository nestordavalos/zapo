/**
 * Builds a 12-byte nonce for AES-GCM encryption with counter in the last 4 bytes
 */
export function buildNonce(counter: number): Uint8Array {
    const nonce = new Uint8Array(12)
    nonce[8] = (counter >>> 24) & 0xff
    nonce[9] = (counter >>> 16) & 0xff
    nonce[10] = (counter >>> 8) & 0xff
    nonce[11] = counter & 0xff
    return nonce
}
