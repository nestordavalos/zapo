import { toBytesView } from '@util/bytes'

/**
 * Base64 URL encoding utilities
 */

/**
 * Decodes a base64url encoded string to Uint8Array
 */
export function decodeBase64Url(value: string | undefined, field: string): Uint8Array {
    if (!value) {
        throw new Error(`missing ${field}`)
    }
    const padded = value
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=')
    return toBytesView(Buffer.from(padded, 'base64'))
}

/**
 * Asserts that a Uint8Array is exactly 32 bytes
 */
export function assert32(value: Uint8Array, name: string): void {
    if (value.length !== 32) {
        throw new Error(`${name} must be 32 bytes`)
    }
}
