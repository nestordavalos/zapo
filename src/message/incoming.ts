import type { WaIncomingMessageEvent, WaIncomingUnhandledStanzaEvent } from '@client/types'
import type { Logger } from '@infra/log/types'
import { unwrapDeviceSentMessage } from '@message/device-sent'
import { unpadPkcs7 } from '@message/padding'
import { proto } from '@proto'
import { WA_MESSAGE_TAGS, WA_MESSAGE_TYPES } from '@protocol/constants'
import { parseSignalAddressFromJid } from '@protocol/jid'
import type { WaRetryDecryptFailureContext } from '@retry/types'
import type { SenderKeyManager } from '@signal/group/SenderKeyManager'
import type { SignalProtocol } from '@signal/session/SignalProtocol'
import {
    buildInboundDeliveryReceiptNode,
    buildInboundMessageAckNode,
    buildInboundRetryReceiptNode
} from '@transport/node/builders/message'
import { decodeBinaryNodeContent, findNodeChild } from '@transport/node/helpers'
import type { BinaryNode } from '@transport/types'
import { toError } from '@util/primitives'

interface WaIncomingMessageAckHandlerOptions {
    readonly logger: Logger
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly getMeJid?: () => string | null | undefined
    readonly signalProtocol?: SignalProtocol
    readonly senderKeyManager?: SenderKeyManager
    readonly onDecryptFailure?: (
        context: WaRetryDecryptFailureContext,
        error: unknown
    ) => Promise<boolean>
    readonly emitIncomingMessage?: (event: WaIncomingMessageEvent) => void
    readonly emitUnhandledStanza?: (event: WaIncomingUnhandledStanzaEvent) => void
}

function pickMessageSenderJid(node: BinaryNode): string | undefined {
    if (node.attrs.participant) {
        return node.attrs.participant
    }
    if (node.attrs.from) {
        return node.attrs.from
    }
    return undefined
}

function pickMessageChatJid(node: BinaryNode): string | undefined {
    return node.attrs.from
}

function buildBaseIncomingEvent(node: BinaryNode): {
    readonly rawNode: BinaryNode
    readonly id?: string
    readonly from?: string
    readonly type?: string
} {
    return {
        rawNode: node,
        id: node.attrs.id,
        from: node.attrs.from,
        type: node.attrs.type
    }
}

function pickSenderKeyDistributionPayload(
    message: proto.IMessage
): { readonly groupId: string; readonly payload: Uint8Array } | null {
    const direct = pickDirectSenderKeyDistributionPayload(message)
    if (direct) {
        return direct
    }

    const nestedMessage = message.deviceSentMessage?.message ?? undefined
    if (nestedMessage) {
        return pickSenderKeyDistributionPayload(nestedMessage)
    }

    return null
}

function pickDirectSenderKeyDistributionPayload(
    message: proto.IMessage
): { readonly groupId: string; readonly payload: Uint8Array } | null {
    const senderKeyDistribution = message.senderKeyDistributionMessage
    if (
        senderKeyDistribution?.groupId &&
        senderKeyDistribution.axolotlSenderKeyDistributionMessage
    ) {
        return {
            groupId: senderKeyDistribution.groupId,
            payload: senderKeyDistribution.axolotlSenderKeyDistributionMessage
        }
    }

    const fastRatchetSenderKeyDistribution = message.fastRatchetKeySenderKeyDistributionMessage
    if (
        fastRatchetSenderKeyDistribution?.groupId &&
        fastRatchetSenderKeyDistribution.axolotlSenderKeyDistributionMessage
    ) {
        return {
            groupId: fastRatchetSenderKeyDistribution.groupId,
            payload: fastRatchetSenderKeyDistribution.axolotlSenderKeyDistributionMessage
        }
    }

    return null
}

async function maybeProcessSenderKeyDistributionMessage(
    senderJid: string | undefined,
    message: proto.IMessage,
    options: WaIncomingMessageAckHandlerOptions,
    node: BinaryNode
): Promise<void> {
    if (!senderJid || !options.senderKeyManager) {
        return
    }

    const senderKeyDistribution = pickSenderKeyDistributionPayload(message)
    if (!senderKeyDistribution) {
        return
    }

    try {
        await options.senderKeyManager.processSenderKeyDistributionPayload(
            senderKeyDistribution.groupId,
            parseSignalAddressFromJid(senderJid),
            senderKeyDistribution.payload
        )
        options.logger.debug('processed incoming sender key distribution', {
            id: node.attrs.id,
            from: node.attrs.from,
            participant: node.attrs.participant,
            groupId: senderKeyDistribution.groupId
        })
    } catch (error) {
        options.logger.warn('failed to process incoming sender key distribution', {
            id: node.attrs.id,
            from: node.attrs.from,
            participant: node.attrs.participant,
            groupId: senderKeyDistribution.groupId,
            message: toError(error).message
        })
    }
}

async function sendRetryReceiptForDecryptFailure(
    node: BinaryNode,
    options: WaIncomingMessageAckHandlerOptions,
    error: unknown,
    encType: string
): Promise<boolean> {
    const stanzaId = node.attrs.id
    const from = node.attrs.from
    if (!stanzaId || !from) {
        return false
    }

    const retryContext: WaRetryDecryptFailureContext = {
        messageNode: node,
        stanzaId,
        from,
        participant: node.attrs.participant,
        recipient: node.attrs.recipient,
        t: node.attrs.t
    }

    if (options.onDecryptFailure) {
        return options.onDecryptFailure(retryContext, error)
    }

    const retryReceiptNode = buildInboundRetryReceiptNode(
        node,
        stanzaId,
        from,
        options.getMeJid?.()
    )
    try {
        await options.sendNode(retryReceiptNode)
        options.logger.debug('sent retry receipt for undecryptable incoming message', {
            id: stanzaId,
            to: from,
            participant: retryReceiptNode.attrs.participant,
            encType
        })
        return true
    } catch (retryError) {
        options.logger.warn('failed to send retry receipt for incoming message', {
            id: stanzaId,
            from,
            participant: node.attrs.participant,
            encType,
            message: toError(retryError).message
        })
        return false
    }
}

export async function handleIncomingMessageAck(
    node: BinaryNode,
    options: WaIncomingMessageAckHandlerOptions
): Promise<boolean> {
    if (node.tag !== WA_MESSAGE_TAGS.MESSAGE) {
        return false
    }

    let shouldSendStandardReceipt = true
    const encNode = findNodeChild(node, WA_MESSAGE_TAGS.ENC)
    if (encNode) {
        const encType = encNode.attrs.type
        const senderJid = pickMessageSenderJid(node)
        const chatJid = pickMessageChatJid(node)
        if (encType === 'skmsg' && senderJid && chatJid && options.senderKeyManager) {
            try {
                const ciphertext = decodeBinaryNodeContent(encNode.content, 'message.enc')
                const plaintext = await options.senderKeyManager.decryptGroupMessage({
                    groupId: chatJid,
                    sender: parseSignalAddressFromJid(senderJid),
                    ciphertext
                })
                const unpaddedPlaintext = unpadPkcs7(plaintext)
                const message = normalizeIncomingDecryptedMessage(
                    proto.Message.decode(unpaddedPlaintext)
                )
                await maybeProcessSenderKeyDistributionMessage(senderJid, message, options, node)
                options.emitIncomingMessage?.({
                    ...buildBaseIncomingEvent(node),
                    senderJid,
                    encType,
                    plaintext: unpaddedPlaintext,
                    message
                })
            } catch (error) {
                options.logger.warn('failed to decrypt incoming message', {
                    id: node.attrs.id,
                    from: node.attrs.from,
                    participant: node.attrs.participant,
                    encType,
                    message: toError(error).message
                })
                options.emitUnhandledStanza?.({
                    ...buildBaseIncomingEvent(node),
                    reason: `message.decrypt_failed.${encType}`
                })

                const retrySent = await sendRetryReceiptForDecryptFailure(
                    node,
                    options,
                    error,
                    encType
                )
                if (retrySent) {
                    shouldSendStandardReceipt = false
                }
            }
        } else if (encType === 'skmsg') {
            options.emitUnhandledStanza?.({
                ...buildBaseIncomingEvent(node),
                reason: 'message.skmsg.missing_group_context'
            })
        } else if (
            (encType === 'msg' || encType === 'pkmsg') &&
            senderJid &&
            options.signalProtocol
        ) {
            try {
                const ciphertext = decodeBinaryNodeContent(encNode.content, 'message.enc')
                const plaintext = await options.signalProtocol.decryptMessage(
                    parseSignalAddressFromJid(senderJid),
                    {
                        type: encType,
                        ciphertext
                    }
                )
                const unpaddedPlaintext = unpadPkcs7(plaintext)
                const message = normalizeIncomingDecryptedMessage(
                    proto.Message.decode(unpaddedPlaintext)
                )
                await maybeProcessSenderKeyDistributionMessage(senderJid, message, options, node)
                options.emitIncomingMessage?.({
                    ...buildBaseIncomingEvent(node),
                    senderJid,
                    encType,
                    plaintext: unpaddedPlaintext,
                    message
                })
            } catch (error) {
                options.logger.warn('failed to decrypt incoming message', {
                    id: node.attrs.id,
                    from: node.attrs.from,
                    participant: node.attrs.participant,
                    encType,
                    message: toError(error).message
                })
                options.emitUnhandledStanza?.({
                    ...buildBaseIncomingEvent(node),
                    reason: `message.decrypt_failed.${encType}`
                })

                const retrySent = await sendRetryReceiptForDecryptFailure(
                    node,
                    options,
                    error,
                    encType
                )
                if (retrySent) {
                    shouldSendStandardReceipt = false
                }
            }
        }
    }

    const id = node.attrs.id
    const from = node.attrs.from
    if (!id || !from) {
        options.logger.warn('incoming message missing required attrs for ack/receipt', {
            hasId: Boolean(id),
            hasFrom: Boolean(from),
            type: node.attrs.type
        })
        return true
    }

    if (node.attrs.type === WA_MESSAGE_TYPES.MEDIA_NOTIFY) {
        const ackNode = buildInboundMessageAckNode(node, id, from, options.getMeJid?.())
        options.logger.debug('sending inbound message ack', {
            id,
            to: from,
            type: ackNode.attrs.type,
            participant: ackNode.attrs.participant
        })
        await options.sendNode(ackNode)
        return true
    }

    if (!shouldSendStandardReceipt) {
        return true
    }

    const receiptNode = buildInboundDeliveryReceiptNode(node, id, from)
    options.logger.debug('sending inbound message receipt', {
        id,
        to: from,
        type: receiptNode.attrs.type,
        participant: receiptNode.attrs.participant
    })
    await options.sendNode(receiptNode)
    return true
}

function normalizeIncomingDecryptedMessage(message: proto.IMessage): proto.IMessage {
    return unwrapDeviceSentMessage(message) ?? message
}
