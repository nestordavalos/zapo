import type { WaMediaTransferClient } from '../media/WaMediaTransferClient'
import type { Proto } from '../proto'
import { decodeProtoBytes } from '../util/base64'
import { toBufferView } from '../util/bytes'

import type { AppStateCollectionName } from './types'

export function keyIdToHex(keyId: Uint8Array): string {
    return toBufferView(keyId).toString('hex')
}

export function longToNumber(value: number | { toNumber(): number } | null | undefined): number {
    if (value === null || value === undefined) {
        return 0
    }
    if (typeof value === 'number') {
        return value
    }
    return value.toNumber()
}

export function parseCollectionName(value: string | undefined): AppStateCollectionName | null {
    switch (value) {
        case 'regular':
        case 'regular_low':
        case 'regular_high':
        case 'critical_block':
        case 'critical_unblock_low':
            return value
        default:
            return null
    }
}

export function keyDeviceId(keyId: Uint8Array): number {
    if (keyId.byteLength < 6) {
        return Number.MAX_SAFE_INTEGER
    }
    return (keyId[0] << 8) | keyId[1]
}

export function keyEpoch(keyId: Uint8Array): number {
    if (keyId.byteLength < 6) {
        return -1
    }
    return new DataView(keyId.buffer, keyId.byteOffset, keyId.byteLength).getUint32(2, false)
}

export function toNetworkOrder64(value: number): Uint8Array {
    const out = new Uint8Array(8)
    const view = new DataView(out.buffer)
    view.setUint32(0, Math.floor(value / 0x1_0000_0000), false)
    view.setUint32(4, value >>> 0, false)
    return out
}

export async function downloadExternalBlobReference(
    mediaTransfer: WaMediaTransferClient,
    reference: Proto.IExternalBlobReference
): Promise<Uint8Array> {
    if (!reference.directPath) {
        throw new Error('external blob reference is missing directPath')
    }
    const mediaKey = decodeProtoBytes(reference.mediaKey, 'external blob mediaKey')
    const fileSha256 = decodeProtoBytes(reference.fileSha256, 'external blob fileSha256')
    const fileEncSha256 = decodeProtoBytes(reference.fileEncSha256, 'external blob fileEncSha256')
    return mediaTransfer.downloadAndDecrypt({
        directPath: reference.directPath,
        mediaType: 'md-app-state',
        mediaKey,
        fileSha256,
        fileEncSha256
    })
}
