/**
 * Error handling utilities
 */

/**
 * Converts an unknown value to an Error instance
 */
export function toError(value: unknown): Error {
    if (value instanceof Error) {
        return value
    }
    if (typeof value === 'string') {
        return new Error(value)
    }
    return new Error('unknown error')
}
