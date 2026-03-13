import type { Logger } from '@infra/log/types'
import { WA_DEFAULTS, WA_IQ_TYPES, WA_NODE_TAGS, WA_XMLNS } from '@protocol/constants'
import {
    SIGNAL_KEY_DATA_LENGTH,
    SIGNAL_KEY_ID_LENGTH,
    SIGNAL_REGISTRATION_ID_LENGTH,
    SIGNAL_SIGNATURE_LENGTH
} from '@signal/api/constants'
import type { SignalPreKeyBundle } from '@signal/types'
import {
    findNodeChild,
    getNodeChildrenByTag,
    decodeNodeContentBase64OrBytes
} from '@transport/node/helpers'
import type { BinaryNode } from '@transport/types'

function decodeExactLength(
    value: BinaryNode['content'],
    field: string,
    expectedLength: number
): Uint8Array {
    const bytes = decodeNodeContentBase64OrBytes(value, field)
    if (bytes.byteLength !== expectedLength) {
        throw new Error(`${field} must be ${expectedLength} bytes`)
    }
    return bytes
}

function parseUint24(bytes: Uint8Array): number {
    return (bytes[0] << 16) | (bytes[1] << 8) | bytes[2]
}

interface SignalSessionSyncApiOptions {
    readonly logger: Logger
    readonly query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
    readonly defaultTimeoutMs?: number
    readonly hostDomain?: string
}

export class SignalSessionSyncApi {
    private readonly logger: SignalSessionSyncApiOptions['logger']
    private readonly query: SignalSessionSyncApiOptions['query']
    private readonly defaultTimeoutMs: number
    private readonly hostDomain: string

    public constructor(options: SignalSessionSyncApiOptions) {
        this.logger = options.logger
        this.query = options.query
        this.defaultTimeoutMs =
            options.defaultTimeoutMs ?? WA_DEFAULTS.SIGNAL_FETCH_KEY_BUNDLES_TIMEOUT_MS
        this.hostDomain = options.hostDomain ?? WA_DEFAULTS.HOST_DOMAIN
    }

    public async fetchKeyBundle(
        target: {
            readonly jid: string
            readonly reasonIdentity?: boolean
        },
        timeoutMs = this.defaultTimeoutMs
    ): Promise<{
        readonly jid: string
        readonly bundle: SignalPreKeyBundle
        readonly deviceIdentity?: Uint8Array
    }> {
        this.logger.debug('signal fetch key bundle request', {
            jid: target.jid,
            reasonIdentity: target.reasonIdentity === true,
            timeoutMs
        })
        const responseNode = await this.query(
            {
                tag: WA_NODE_TAGS.IQ,
                attrs: {
                    type: WA_IQ_TYPES.GET,
                    xmlns: WA_XMLNS.SIGNAL,
                    to: this.hostDomain
                },
                content: [
                    {
                        tag: WA_NODE_TAGS.KEY,
                        attrs: {},
                        content: [
                            {
                                tag: WA_NODE_TAGS.USER,
                                attrs: {
                                    jid: target.jid,
                                    ...(target.reasonIdentity ? { reason: 'identity' } : {})
                                }
                            }
                        ]
                    }
                ]
            },
            timeoutMs
        )
        const parsed = this.parseFetchKeyBundleResponse(responseNode, target.jid)
        this.logger.debug('signal fetch key bundle success', {
            requestJid: target.jid,
            responseJid: parsed.jid,
            hasOneTimeKey: parsed.bundle.oneTimeKey !== undefined,
            hasDeviceIdentity: parsed.deviceIdentity !== undefined
        })
        return parsed
    }

    private parseFetchKeyBundleResponse(
        node: BinaryNode,
        expectedJid: string
    ): {
        readonly jid: string
        readonly bundle: SignalPreKeyBundle
        readonly deviceIdentity?: Uint8Array
    } {
        if (node.tag !== WA_NODE_TAGS.IQ) {
            throw new Error(`invalid key bundle response tag: ${node.tag}`)
        }
        if (node.attrs.type === WA_IQ_TYPES.ERROR) {
            const errorNode = findNodeChild(node, WA_NODE_TAGS.ERROR)
            if (!errorNode) {
                throw new Error(`key bundle iq error for ${node.attrs.id ?? 'unknown id'}`)
            }
            const code = errorNode.attrs.code ?? 'unknown'
            const text = errorNode.attrs.text ?? errorNode.attrs.type ?? 'unknown'
            throw new Error(`key bundle iq error (${code} ${text})`)
        }
        if (node.attrs.type !== WA_IQ_TYPES.RESULT) {
            throw new Error(`invalid key bundle response type: ${node.attrs.type ?? 'unknown'}`)
        }

        const listNode = findNodeChild(node, WA_NODE_TAGS.LIST)
        if (!listNode) {
            throw new Error('key bundle response missing list node')
        }
        const userNodes = getNodeChildrenByTag(listNode, WA_NODE_TAGS.USER)
        if (userNodes.length === 0) {
            throw new Error('key bundle response list is empty')
        }

        const userNode = userNodes.find((entry) => entry.attrs.jid === expectedJid) ?? userNodes[0]
        const userJid = userNode.attrs.jid ?? expectedJid
        const userErrorNode = findNodeChild(userNode, WA_NODE_TAGS.ERROR)
        if (userErrorNode) {
            const code = userErrorNode.attrs.code ?? 'unknown'
            const text = userErrorNode.attrs.text ?? 'unknown'
            throw new Error(`key bundle user error (${userJid}): ${code} ${text}`)
        }

        const parsed = this.parseUserKeyBundle(userNode)
        return {
            jid: userJid,
            bundle: parsed.bundle,
            ...(parsed.deviceIdentity ? { deviceIdentity: parsed.deviceIdentity } : {})
        }
    }

    private parseUserKeyBundle(node: BinaryNode): {
        readonly bundle: SignalPreKeyBundle
        readonly deviceIdentity?: Uint8Array
    } {
        const registrationNode = findNodeChild(node, WA_NODE_TAGS.REGISTRATION)
        if (!registrationNode) {
            throw new Error('key bundle user missing registration node')
        }
        const identityNode = findNodeChild(node, WA_NODE_TAGS.IDENTITY)
        if (!identityNode) {
            throw new Error('key bundle user missing identity node')
        }
        const signedPreKeyNode = findNodeChild(node, WA_NODE_TAGS.SKEY)
        if (!signedPreKeyNode) {
            throw new Error('key bundle user missing signed pre-key node')
        }

        const registrationBytes = decodeExactLength(
            registrationNode.content,
            'key bundle registration',
            SIGNAL_REGISTRATION_ID_LENGTH
        )
        const registrationId = new DataView(
            registrationBytes.buffer,
            registrationBytes.byteOffset,
            registrationBytes.byteLength
        ).getUint32(0, false)

        const identity = decodeExactLength(
            identityNode.content,
            'key bundle identity',
            SIGNAL_KEY_DATA_LENGTH
        )

        const signedIdNode = findNodeChild(signedPreKeyNode, WA_NODE_TAGS.ID)
        const signedValueNode = findNodeChild(signedPreKeyNode, WA_NODE_TAGS.VALUE)
        const signedSignatureNode = findNodeChild(signedPreKeyNode, WA_NODE_TAGS.SIGNATURE)
        if (!signedIdNode || !signedValueNode || !signedSignatureNode) {
            throw new Error('key bundle signed pre-key is incomplete')
        }

        const signedIdBytes = decodeExactLength(
            signedIdNode.content,
            'key bundle skey.id',
            SIGNAL_KEY_ID_LENGTH
        )
        const signedValue = decodeExactLength(
            signedValueNode.content,
            'key bundle skey.value',
            SIGNAL_KEY_DATA_LENGTH
        )
        const signedSignature = decodeExactLength(
            signedSignatureNode.content,
            'key bundle skey.signature',
            SIGNAL_SIGNATURE_LENGTH
        )

        const preKeyNode = findNodeChild(node, WA_NODE_TAGS.KEY)
        let oneTimeKey: SignalPreKeyBundle['oneTimeKey']
        if (preKeyNode) {
            const preKeyIdNode = findNodeChild(preKeyNode, WA_NODE_TAGS.ID)
            const preKeyValueNode = findNodeChild(preKeyNode, WA_NODE_TAGS.VALUE)
            if (!preKeyIdNode || !preKeyValueNode) {
                throw new Error('key bundle one-time pre-key is incomplete')
            }
            const preKeyIdBytes = decodeExactLength(
                preKeyIdNode.content,
                'key bundle key.id',
                SIGNAL_KEY_ID_LENGTH
            )
            const preKeyValue = decodeExactLength(
                preKeyValueNode.content,
                'key bundle key.value',
                SIGNAL_KEY_DATA_LENGTH
            )

            oneTimeKey = {
                id: parseUint24(preKeyIdBytes),
                publicKey: preKeyValue
            }
        }

        const deviceIdentityNode = findNodeChild(node, WA_NODE_TAGS.DEVICE_IDENTITY)
        const deviceIdentity = deviceIdentityNode
            ? decodeNodeContentBase64OrBytes(
                  deviceIdentityNode.content,
                  'key bundle device-identity'
              )
            : undefined

        return {
            bundle: {
                regId: registrationId,
                identity,
                signedKey: {
                    id: parseUint24(signedIdBytes),
                    publicKey: signedValue,
                    signature: signedSignature
                },
                ...(oneTimeKey ? { oneTimeKey } : {})
            },
            ...(deviceIdentity ? { deviceIdentity } : {})
        }
    }
}
