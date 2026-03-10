import { findNodeChild, getNodeChildrenByTag, decodeBinaryNodeContent } from '../../transport/node/helpers'
import type { BinaryNode } from '../../transport/types'
import type { SignalPreKeyBundle } from '../types'

import {
    SIGNAL_FETCH_KEY_BUNDLES_HOST,
    SIGNAL_FETCH_KEY_BUNDLES_TIMEOUT_MS,
    SIGNAL_FETCH_KEY_BUNDLES_XMLNS,
    SIGNAL_KEY_DATA_LENGTH,
    SIGNAL_KEY_ID_LENGTH,
    SIGNAL_REGISTRATION_ID_LENGTH,
    SIGNAL_SIGNATURE_LENGTH
} from './constants'
import type {
    SignalFetchKeyBundleTarget,
    SignalFetchedKeyBundle,
    SignalSessionSyncApiOptions
} from './types'

export class SignalSessionSyncApi {
    private readonly logger: SignalSessionSyncApiOptions['logger']
    private readonly query: SignalSessionSyncApiOptions['query']
    private readonly defaultTimeoutMs: number
    private readonly hostDomain: string

    public constructor(options: SignalSessionSyncApiOptions) {
        this.logger = options.logger
        this.query = options.query
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? SIGNAL_FETCH_KEY_BUNDLES_TIMEOUT_MS
        this.hostDomain = options.hostDomain ?? SIGNAL_FETCH_KEY_BUNDLES_HOST
    }

    public async fetchKeyBundle(
        target: SignalFetchKeyBundleTarget,
        timeoutMs = this.defaultTimeoutMs
    ): Promise<SignalFetchedKeyBundle> {
        const requestNode = this.makeFetchKeyBundleRequest(target)
        this.logger.debug('signal fetch key bundle request', {
            jid: target.jid,
            reasonIdentity: target.reasonIdentity === true,
            timeoutMs
        })
        const responseNode = await this.query(requestNode, timeoutMs)
        const parsed = this.parseFetchKeyBundleResponse(responseNode, target.jid)
        this.logger.debug('signal fetch key bundle success', {
            requestJid: target.jid,
            responseJid: parsed.jid,
            hasOneTimeKey: parsed.bundle.oneTimeKey !== undefined,
            hasDeviceIdentity: parsed.deviceIdentity !== undefined
        })
        return parsed
    }

    private makeFetchKeyBundleRequest(target: SignalFetchKeyBundleTarget): BinaryNode {
        return {
            tag: 'iq',
            attrs: {
                type: 'get',
                xmlns: SIGNAL_FETCH_KEY_BUNDLES_XMLNS,
                to: this.hostDomain
            },
            content: [
                {
                    tag: 'key',
                    attrs: {},
                    content: [
                        {
                            tag: 'user',
                            attrs: {
                                jid: target.jid,
                                ...(target.reasonIdentity ? { reason: 'identity' } : {})
                            }
                        }
                    ]
                }
            ]
        }
    }

    private parseFetchKeyBundleResponse(node: BinaryNode, expectedJid: string): SignalFetchedKeyBundle {
        if (node.tag !== 'iq') {
            throw new Error(`invalid key bundle response tag: ${node.tag}`)
        }
        if (node.attrs.type === 'error') {
            throw new Error(this.describeIqError(node))
        }
        if (node.attrs.type !== 'result') {
            throw new Error(`invalid key bundle response type: ${node.attrs.type ?? 'unknown'}`)
        }

        const listNode = findNodeChild(node, 'list')
        if (!listNode) {
            throw new Error('key bundle response missing list node')
        }
        const userNodes = getNodeChildrenByTag(listNode, 'user')
        if (userNodes.length === 0) {
            throw new Error('key bundle response list is empty')
        }

        const userNode = this.pickUserNode(userNodes, expectedJid)
        const userJid = userNode.attrs.jid ?? expectedJid
        const userErrorNode = findNodeChild(userNode, 'error')
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

    private pickUserNode(nodes: readonly BinaryNode[], expectedJid: string): BinaryNode {
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index]
            if (node.attrs.jid === expectedJid) {
                return node
            }
        }
        return nodes[0]
    }

    private parseUserKeyBundle(node: BinaryNode): {
        readonly bundle: SignalPreKeyBundle
        readonly deviceIdentity?: Uint8Array
    } {
        const registrationNode = findNodeChild(node, 'registration')
        if (!registrationNode) {
            throw new Error('key bundle user missing registration node')
        }
        const identityNode = findNodeChild(node, 'identity')
        if (!identityNode) {
            throw new Error('key bundle user missing identity node')
        }
        const signedPreKeyNode = findNodeChild(node, 'skey')
        if (!signedPreKeyNode) {
            throw new Error('key bundle user missing signed pre-key node')
        }

        const registrationBytes = decodeBinaryNodeContent(
            registrationNode.content,
            'key bundle registration'
        )
        this.assertLength(
            registrationBytes,
            SIGNAL_REGISTRATION_ID_LENGTH,
            'key bundle registration bytes'
        )
        const registrationId = new DataView(
            registrationBytes.buffer,
            registrationBytes.byteOffset,
            registrationBytes.byteLength
        ).getUint32(0, false)

        const identity = decodeBinaryNodeContent(identityNode.content, 'key bundle identity')
        this.assertLength(identity, SIGNAL_KEY_DATA_LENGTH, 'key bundle identity')

        const signedIdNode = findNodeChild(signedPreKeyNode, 'id')
        const signedValueNode = findNodeChild(signedPreKeyNode, 'value')
        const signedSignatureNode = findNodeChild(signedPreKeyNode, 'signature')
        if (!signedIdNode || !signedValueNode || !signedSignatureNode) {
            throw new Error('key bundle signed pre-key is incomplete')
        }

        const signedIdBytes = decodeBinaryNodeContent(signedIdNode.content, 'key bundle skey.id')
        this.assertLength(signedIdBytes, SIGNAL_KEY_ID_LENGTH, 'key bundle skey.id')
        const signedValue = decodeBinaryNodeContent(
            signedValueNode.content,
            'key bundle skey.value'
        )
        this.assertLength(signedValue, SIGNAL_KEY_DATA_LENGTH, 'key bundle skey.value')
        const signedSignature = decodeBinaryNodeContent(
            signedSignatureNode.content,
            'key bundle skey.signature'
        )
        this.assertLength(
            signedSignature,
            SIGNAL_SIGNATURE_LENGTH,
            'key bundle skey.signature'
        )

        const preKeyNode = findNodeChild(node, 'key')
        let oneTimeKey: SignalPreKeyBundle['oneTimeKey']
        if (preKeyNode) {
            const preKeyIdNode = findNodeChild(preKeyNode, 'id')
            const preKeyValueNode = findNodeChild(preKeyNode, 'value')
            if (!preKeyIdNode || !preKeyValueNode) {
                throw new Error('key bundle one-time pre-key is incomplete')
            }
            const preKeyIdBytes = decodeBinaryNodeContent(
                preKeyIdNode.content,
                'key bundle key.id'
            )
            this.assertLength(preKeyIdBytes, SIGNAL_KEY_ID_LENGTH, 'key bundle key.id')
            const preKeyValue = decodeBinaryNodeContent(
                preKeyValueNode.content,
                'key bundle key.value'
            )
            this.assertLength(preKeyValue, SIGNAL_KEY_DATA_LENGTH, 'key bundle key.value')

            oneTimeKey = {
                id: this.parseUint24(preKeyIdBytes),
                publicKey: preKeyValue
            }
        }

        const deviceIdentityNode = findNodeChild(node, 'device-identity')
        const deviceIdentity = deviceIdentityNode
            ? decodeBinaryNodeContent(deviceIdentityNode.content, 'key bundle device-identity')
            : undefined

        return {
            bundle: {
                regId: registrationId,
                identity,
                signedKey: {
                    id: this.parseUint24(signedIdBytes),
                    publicKey: signedValue,
                    signature: signedSignature
                },
                ...(oneTimeKey ? { oneTimeKey } : {})
            },
            ...(deviceIdentity ? { deviceIdentity } : {})
        }
    }

    private parseUint24(bytes: Uint8Array): number {
        return (bytes[0] << 16) | (bytes[1] << 8) | bytes[2]
    }

    private assertLength(bytes: Uint8Array, expectedLength: number, field: string): void {
        if (bytes.byteLength !== expectedLength) {
            throw new Error(`${field} must be ${expectedLength} bytes`)
        }
    }

    private describeIqError(node: BinaryNode): string {
        const errorNode = findNodeChild(node, 'error')
        if (!errorNode) {
            return `key bundle iq error for ${node.attrs.id ?? 'unknown id'}`
        }
        const code = errorNode.attrs.code ?? 'unknown'
        const text = errorNode.attrs.text ?? errorNode.attrs.type ?? 'unknown'
        return `key bundle iq error (${code} ${text})`
    }
}

