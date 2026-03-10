import { asNodeBytes, getNodeChildrenByTag } from '../../transport/node/helpers'
import type { BinaryNode } from '../../transport/types'
import { HOST_DOMAIN } from '../client.constants'

const TEXT_DECODER = new TextDecoder()
const ZERO_BYTE = new Uint8Array([0])

export function buildCompanionHelloRequestNode(args: {
    readonly phoneJid: string
    readonly shouldShowPushNotification: boolean
    readonly wrappedCompanionEphemeralPub: Uint8Array
    readonly companionServerAuthKeyPub: Uint8Array
    readonly companionPlatformId: string
    readonly companionPlatformDisplay: string
}): BinaryNode {
    return {
        tag: 'iq',
        attrs: {
            to: HOST_DOMAIN,
            type: 'set',
            xmlns: 'md'
        },
        content: [
            {
                tag: 'link_code_companion_reg',
                attrs: {
                    jid: args.phoneJid,
                    stage: 'companion_hello',
                    should_show_push_notification: args.shouldShowPushNotification ? 'true' : 'false'
                },
                content: [
                    {
                        tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
                        attrs: {},
                        content: args.wrappedCompanionEphemeralPub
                    },
                    {
                        tag: 'companion_server_auth_key_pub',
                        attrs: {},
                        content: args.companionServerAuthKeyPub
                    },
                    {
                        tag: 'companion_platform_id',
                        attrs: {},
                        content: args.companionPlatformId
                    },
                    {
                        tag: 'companion_platform_display',
                        attrs: {},
                        content: args.companionPlatformDisplay
                    },
                    {
                        tag: 'link_code_pairing_nonce',
                        attrs: {},
                        content: ZERO_BYTE
                    }
                ]
            }
        ]
    }
}

export function buildGetCountryCodeRequestNode(): BinaryNode {
    return {
        tag: 'iq',
        attrs: {
            to: HOST_DOMAIN,
            type: 'get',
            xmlns: 'md'
        },
        content: [
            {
                tag: 'link_code_companion_reg',
                attrs: {
                    stage: 'get_country_code'
                }
            }
        ]
    }
}

export function buildCompanionFinishRequestNode(args: {
    readonly phoneJid: string
    readonly wrappedKeyBundle: Uint8Array
    readonly companionIdentityPublic: Uint8Array
    readonly ref: Uint8Array
}): BinaryNode {
    return {
        tag: 'iq',
        attrs: {
            to: HOST_DOMAIN,
            type: 'set',
            xmlns: 'md'
        },
        content: [
            {
                tag: 'link_code_companion_reg',
                attrs: {
                    jid: args.phoneJid,
                    stage: 'companion_finish'
                },
                content: [
                    {
                        tag: 'link_code_pairing_wrapped_key_bundle',
                        attrs: {},
                        content: args.wrappedKeyBundle
                    },
                    {
                        tag: 'companion_identity_public',
                        attrs: {},
                        content: args.companionIdentityPublic
                    },
                    {
                        tag: 'link_code_pairing_ref',
                        attrs: {},
                        content: args.ref
                    }
                ]
            }
        ]
    }
}

export function buildNotificationAckNode(
    node: BinaryNode,
    typeOverride?: string
): BinaryNode {
    const attrs: Record<string, string> = {
        to: node.attrs.from ?? HOST_DOMAIN,
        class: 'notification',
        type: typeOverride ?? node.attrs.type ?? 'notification'
    }
    if (node.attrs.id) {
        attrs.id = node.attrs.id
    }
    return {
        tag: 'ack',
        attrs
    }
}

export function buildIqResultNode(iqNode: BinaryNode): BinaryNode {
    return {
        tag: 'iq',
        attrs: {
            ...(iqNode.attrs.id ? { id: iqNode.attrs.id } : {}),
            to: iqNode.attrs.from ?? HOST_DOMAIN,
            type: 'result'
        }
    }
}

export function extractPairDeviceRefs(pairDeviceNode: BinaryNode): readonly string[] {
    return getNodeChildrenByTag(pairDeviceNode, 'ref')
        .map((child) => TEXT_DECODER.decode(asNodeBytes(child.content, 'pair-device.ref')))
        .filter((ref) => ref.length > 0)
}
