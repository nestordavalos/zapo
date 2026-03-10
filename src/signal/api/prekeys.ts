import { buildIqNode, parseIqError } from '../../transport/node/query'
import type { BinaryNode } from '../../transport/types'
import { toBytesView } from '../../util/bytes'
import type { PreKeyRecord, RegistrationInfo, SignedPreKeyRecord } from '../types'

import {
    SIGNAL_FETCH_KEY_BUNDLES_HOST,
    SIGNAL_FETCH_KEY_BUNDLES_XMLNS,
    SIGNAL_KEY_BUNDLE_TYPE_BYTES
} from './constants'

export function intToBigEndianBytes(value: number, byteLength: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid integer value ${value}`)
    }
    const out = new Uint8Array(byteLength)
    let current = value
    for (let index = byteLength - 1; index >= 0; index -= 1) {
        out[index] = current & 0xff
        current = Math.floor(current / 256)
    }
    return out
}

export function buildPreKeyUploadIq(
    registrationInfo: RegistrationInfo,
    signedPreKey: SignedPreKeyRecord,
    preKeys: readonly PreKeyRecord[]
) {
    return buildIqNode('set', SIGNAL_FETCH_KEY_BUNDLES_HOST, SIGNAL_FETCH_KEY_BUNDLES_XMLNS, [
        {
            tag: 'registration',
            attrs: {},
            content: intToBigEndianBytes(registrationInfo.registrationId, 4)
        },
        {
            tag: 'type',
            attrs: {},
            content: SIGNAL_KEY_BUNDLE_TYPE_BYTES
        },
        {
            tag: 'identity',
            attrs: {},
            content: toBytesView(registrationInfo.identityKeyPair.pubKey)
        },
        {
            tag: 'list',
            attrs: {},
            content: preKeys.map((record) => ({
                tag: 'key',
                attrs: {},
                content: [
                    {
                        tag: 'id',
                        attrs: {},
                        content: intToBigEndianBytes(record.keyId, 3)
                    },
                    {
                        tag: 'value',
                        attrs: {},
                        content: toBytesView(record.keyPair.pubKey)
                    }
                ]
            }))
        },
        {
            tag: 'skey',
            attrs: {},
            content: [
                {
                    tag: 'id',
                    attrs: {},
                    content: intToBigEndianBytes(signedPreKey.keyId, 3)
                },
                {
                    tag: 'value',
                    attrs: {},
                    content: toBytesView(signedPreKey.keyPair.pubKey)
                },
                {
                    tag: 'signature',
                    attrs: {},
                    content: toBytesView(signedPreKey.signature)
                }
            ]
        }
    ])
}

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
