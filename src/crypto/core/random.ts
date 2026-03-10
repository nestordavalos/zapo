import { randomBytes, randomInt } from 'node:crypto'

import { toBytesView } from '../../util/bytes'

/**
 * Generates cryptographically secure random bytes
 */
export function randomBytesAsync(size: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
        randomBytes(size, (error, buffer) => {
            if (error) reject(error)
            else resolve(toBytesView(buffer))
        })
    })
}

/**
 * Generates a cryptographically secure random integer in the range [min, max)
 */
export function randomIntAsync(min: number, max: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        randomInt(min, max, (error, value) => {
            if (error) reject(error)
            else resolve(value)
        })
    })
}
