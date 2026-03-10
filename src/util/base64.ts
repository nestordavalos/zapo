import { toBufferView, toBytesView } from '@util/bytes'

export function bytesToBase64(value: Uint8Array): string {
    return toBufferView(value).toString('base64')
}

export function bytesToBase64UrlSafe(value: Uint8Array): string {
    return bytesToBase64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function base64ToBytes(value: string, field: string, requireNonEmpty = true): Uint8Array {
    const out = toBytesView(Buffer.from(value, 'base64'))
    if (requireNonEmpty && out.length === 0) {
        throw new Error(`invalid base64 payload for ${field}`)
    }
    return out
}

export function decodeProtoBytes(
    value: Uint8Array | string | null | undefined,
    field: string
): Uint8Array {
    if (value === null || value === undefined) {
        throw new Error(`missing protobuf bytes field ${field}`)
    }
    if (value instanceof Uint8Array) {
        return value
    }
    return toBytesView(Buffer.from(value, 'base64'))
}
