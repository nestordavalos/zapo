import { timingSafeEqual } from 'node:crypto'

/**
 * Byte array manipulation utilities
 */

/**
 * Concatenates multiple Uint8Array into a single Uint8Array
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, current) => sum + current.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
        out.set(part, offset)
        offset += part.length
    }
    return out
}

/**
 * Returns a Uint8Array view without copying when possible
 */
export function toBytesView(value: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
    if (value instanceof Uint8Array) {
        return value
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    }
    return new Uint8Array(value)
}

/**
 * Returns a Buffer view for a Uint8Array without copying when possible
 */
export function toBufferView(value: Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) {
        return value
    }
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

/**
 * Converts stream/input chunks to Buffer with minimal copies
 */
export function toBufferChunk(chunk: unknown): Buffer {
    if (Buffer.isBuffer(chunk)) {
        return chunk
    }
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    }
    if (chunk instanceof ArrayBuffer) {
        return Buffer.from(chunk)
    }
    if (typeof chunk === 'string') {
        return Buffer.from(chunk)
    }
    throw new Error(`unsupported stream chunk type: ${typeof chunk}`)
}

/**
 * Constant-time equality for byte arrays
 */
export function uint8TimingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) {
        return false
    }
    return timingSafeEqual(toBufferView(left), toBufferView(right))
}

/**
 * Creates a shallow copy of a Uint8Array
 */
export function cloneBytes(data: Uint8Array): Uint8Array {
    return data.slice()
}

/**
 * Compares two Uint8Array for equality
 */
export function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false
    }
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return false
        }
    }
    return true
}

/**
 * Returns a new array with the element at the given index removed
 */
export function removeAt<T>(items: readonly T[], index: number): T[] {
    const out: T[] = []
    for (let i = 0; i < items.length; i += 1) {
        if (i !== index) {
            out.push(items[i])
        }
    }
    return out
}
