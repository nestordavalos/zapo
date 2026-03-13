import { WA_MESSAGE_TAGS, WA_NODE_TAGS } from '@protocol/constants'
import type { WaParsedRetryRequest, WaRetryKeyBundle, WaRetryReceiptType } from '@retry/types'
import {
    SIGNAL_KEY_DATA_LENGTH,
    SIGNAL_KEY_ID_LENGTH,
    SIGNAL_REGISTRATION_ID_LENGTH,
    SIGNAL_SIGNATURE_LENGTH
} from '@signal/api/constants'
import { decodeNodeContentBase64OrBytes, findNodeChild } from '@transport/node/helpers'
import { parseOptionalInt } from '@transport/stream/parse'
import type { BinaryNode } from '@transport/types'

function parseFixedLengthBytes(
    value: BinaryNode['content'],
    byteLength: number,
    field: string
): Uint8Array {
    const out = decodeNodeContentBase64OrBytes(value, field)
    if (out.byteLength !== byteLength) {
        throw new Error(`${field} must be ${byteLength} bytes`)
    }
    return out
}

function parseBigEndianUint(bytes: Uint8Array, field: string): number {
    if (bytes.byteLength === 0 || bytes.byteLength > 4) {
        throw new Error(`${field} has invalid byte length`)
    }
    let out = 0
    for (let index = 0; index < bytes.byteLength; index += 1) {
        out = (out << 8) | bytes[index]
    }
    return out
}

function parseRetryType(value: string | undefined): WaRetryReceiptType | null {
    if (value === 'retry' || value === 'enc_rekey_retry') {
        return value
    }
    return null
}

function parseRetryCount(value: string | undefined): number {
    const parsed = parseOptionalInt(value)
    if (parsed === undefined) {
        return 0
    }
    if (parsed < 0) {
        throw new Error('retry count must be >= 0')
    }
    return parsed
}

function parseRetryKeyBundle(node: BinaryNode | undefined): WaRetryKeyBundle | undefined {
    if (!node) {
        return undefined
    }
    const identityNode = findNodeChild(node, WA_NODE_TAGS.IDENTITY)
    const signedKeyNode = findNodeChild(node, WA_NODE_TAGS.SKEY)
    if (!identityNode || !signedKeyNode) {
        throw new Error('retry keys section missing identity or skey')
    }

    const signedKeyIdNode = findNodeChild(signedKeyNode, WA_NODE_TAGS.ID)
    const signedKeyValueNode = findNodeChild(signedKeyNode, WA_NODE_TAGS.VALUE)
    const signedKeySignatureNode = findNodeChild(signedKeyNode, WA_NODE_TAGS.SIGNATURE)
    if (!signedKeyIdNode || !signedKeyValueNode || !signedKeySignatureNode) {
        throw new Error('retry keys section has incomplete skey')
    }

    const keyNode = findNodeChild(node, WA_NODE_TAGS.KEY)
    const keyIdNode = keyNode ? findNodeChild(keyNode, WA_NODE_TAGS.ID) : undefined
    const keyValueNode = keyNode ? findNodeChild(keyNode, WA_NODE_TAGS.VALUE) : undefined
    if (keyNode && (!keyIdNode || !keyValueNode)) {
        throw new Error('retry keys section has incomplete key')
    }

    const deviceIdentityNode = findNodeChild(node, WA_NODE_TAGS.DEVICE_IDENTITY)
    return {
        identity: parseFixedLengthBytes(
            identityNode.content,
            SIGNAL_KEY_DATA_LENGTH,
            'retry.keys.identity'
        ),
        deviceIdentity: deviceIdentityNode
            ? decodeNodeContentBase64OrBytes(
                  deviceIdentityNode.content,
                  'retry.keys.device-identity'
              )
            : undefined,
        key:
            keyIdNode && keyValueNode
                ? {
                      id: parseBigEndianUint(
                          parseFixedLengthBytes(
                              keyIdNode.content,
                              SIGNAL_KEY_ID_LENGTH,
                              'retry.keys.key.id'
                          ),
                          'retry.keys.key.id'
                      ),
                      publicKey: parseFixedLengthBytes(
                          keyValueNode.content,
                          SIGNAL_KEY_DATA_LENGTH,
                          'retry.keys.key.value'
                      )
                  }
                : undefined,
        skey: {
            id: parseBigEndianUint(
                parseFixedLengthBytes(
                    signedKeyIdNode.content,
                    SIGNAL_KEY_ID_LENGTH,
                    'retry.keys.skey.id'
                ),
                'retry.keys.skey.id'
            ),
            publicKey: parseFixedLengthBytes(
                signedKeyValueNode.content,
                SIGNAL_KEY_DATA_LENGTH,
                'retry.keys.skey.value'
            ),
            signature: parseFixedLengthBytes(
                signedKeySignatureNode.content,
                SIGNAL_SIGNATURE_LENGTH,
                'retry.keys.skey.signature'
            )
        }
    }
}

export function parseRetryReceiptRequest(node: BinaryNode): WaParsedRetryRequest | null {
    if (node.tag !== WA_MESSAGE_TAGS.RECEIPT) {
        return null
    }
    const receiptType = parseRetryType(node.attrs.type)
    if (!receiptType) {
        return null
    }
    const stanzaId = node.attrs.id
    const from = node.attrs.from
    if (!stanzaId || !from) {
        throw new Error('retry receipt is missing id/from attrs')
    }

    const retryNode = findNodeChild(node, 'retry')
    if (!retryNode) {
        throw new Error('retry receipt is missing retry child')
    }
    const registrationNode = findNodeChild(node, WA_NODE_TAGS.REGISTRATION)
    if (!registrationNode) {
        throw new Error('retry receipt is missing registration child')
    }
    const originalMsgId = retryNode.attrs.id
    if (!originalMsgId) {
        throw new Error('retry receipt is missing retry.id')
    }

    const registration = parseFixedLengthBytes(
        registrationNode.content,
        SIGNAL_REGISTRATION_ID_LENGTH,
        'retry.registration'
    )

    return {
        type: receiptType,
        stanzaId,
        from,
        participant: node.attrs.participant,
        recipient: node.attrs.recipient,
        originalMsgId,
        retryCount: parseRetryCount(retryNode.attrs.count),
        t: retryNode.attrs.t ?? node.attrs.t,
        regId: parseBigEndianUint(registration, 'retry.registration'),
        keyBundle: parseRetryKeyBundle(findNodeChild(node, 'keys'))
    }
}
