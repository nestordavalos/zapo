import { parseIqError } from '@transport/node/query'
import type { BinaryNode } from '@transport/types'
export { buildPreKeyUploadIq, intToBigEndianBytes } from '@transport/node/builders/prekeys'

export function parsePreKeyUploadFailure(node: BinaryNode): {
    readonly errorCode?: number
    readonly errorText: string
} {
    const error = parseIqError(node)
    return {
        ...(error.numericCode !== undefined ? { errorCode: error.numericCode } : {}),
        errorText: error.text
    }
}
