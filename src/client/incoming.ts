import type {
    WaIncomingBaseEvent,
    WaIncomingCallEvent,
    WaIncomingChatstateEvent,
    WaIncomingFailureEvent,
    WaIncomingNotificationEvent,
    WaIncomingPresenceEvent,
    WaIncomingReceiptEvent,
    WaIncomingUnhandledStanzaEvent
} from '@client/types'
import type { Logger } from '@infra/log/types'
import { WA_MESSAGE_TAGS, WA_NODE_TAGS } from '@protocol/constants'
import {
    buildInboundReceiptAckNode,
    buildInboundRetryReceiptAckNode
} from '@transport/node/builders/message'
import { buildNotificationAckNode } from '@transport/node/builders/pairing'
import { getFirstNodeChild } from '@transport/node/helpers'
import { parseOptionalInt } from '@transport/stream/parse'
import type { BinaryNode } from '@transport/types'
import { toError } from '@util/primitives'

interface IncomingNodeHandlerOptions {
    readonly logger: Logger
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly handleIncomingRetryReceipt?: (node: BinaryNode) => Promise<void>
    readonly trackOutboundReceipt?: (node: BinaryNode) => Promise<void>
    readonly emitIncomingReceipt: (event: WaIncomingReceiptEvent) => void
    readonly emitIncomingPresence: (event: WaIncomingPresenceEvent) => void
    readonly emitIncomingChatstate: (event: WaIncomingChatstateEvent) => void
    readonly emitIncomingCall: (event: WaIncomingCallEvent) => void
    readonly emitIncomingFailure: (event: WaIncomingFailureEvent) => void
    readonly emitIncomingErrorStanza: (event: WaIncomingBaseEvent) => void
    readonly emitIncomingNotification: (event: WaIncomingNotificationEvent) => void
    readonly emitUnhandledStanza: (event: WaIncomingUnhandledStanzaEvent) => void
    readonly disconnect: () => Promise<void>
    readonly clearStoredCredentials: () => Promise<void>
}

type NotificationClassification = WaIncomingNotificationEvent['classification']

const LOGOUT_FAILURE_REASONS = new Set<number>([401, 403, 406])
const DISCONNECT_FAILURE_REASONS = new Set<number>([405, 409, 503])

const CORE_NOTIFICATION_TYPES = new Set<string>([
    'server_sync',
    'picture',
    'contacts',
    'devices',
    'disappearing_mode',
    'mediaretry',
    'encrypt',
    'server',
    'status',
    'account_sync',
    'privacy_token',
    'newsletter',
    'w:growth',
    'registration',
    'mex'
])

const OUT_OF_SCOPE_NOTIFICATION_TYPES = new Set<string>([
    'business',
    'pay',
    'psa',
    'waffle',
    'hosted'
])

function buildBaseEvent(node: BinaryNode): WaIncomingBaseEvent {
    return {
        rawNode: node,
        id: node.attrs.id,
        from: node.attrs.from,
        type: node.attrs.type
    }
}

async function sendSafeAck(
    logger: Logger,
    sendNode: (node: BinaryNode) => Promise<void>,
    node: BinaryNode
): Promise<void> {
    try {
        await sendNode(node)
    } catch (error) {
        logger.warn('failed to send inbound ack', {
            tag: node.tag,
            class: node.attrs.class,
            type: node.attrs.type,
            id: node.attrs.id,
            message: toError(error).message
        })
    }
}

function createSimpleIncomingHandler(
    expectedTag: string,
    handle: (node: BinaryNode) => void | Promise<void>
): (node: BinaryNode) => Promise<boolean> {
    return async (node: BinaryNode): Promise<boolean> => {
        if (node.tag !== expectedTag) {
            return false
        }
        await handle(node)
        return true
    }
}

function classifyNotificationType(notificationType: string): NotificationClassification {
    if (CORE_NOTIFICATION_TYPES.has(notificationType)) {
        return 'core'
    }
    if (OUT_OF_SCOPE_NOTIFICATION_TYPES.has(notificationType)) {
        return 'out_of_scope'
    }
    return 'unknown'
}

function emitIncomingNotificationEvent(
    options: IncomingNodeHandlerOptions,
    node: BinaryNode,
    notificationType: string,
    classification: NotificationClassification
): void {
    const firstChildTag = getFirstNodeChild(node)?.tag
    options.emitIncomingNotification({
        ...buildBaseEvent(node),
        notificationType,
        classification,
        details: firstChildTag ? { firstChildTag } : undefined
    })
}

export function createIncomingReceiptHandler(
    options: IncomingNodeHandlerOptions
): (node: BinaryNode) => Promise<boolean> {
    return createSimpleIncomingHandler(WA_MESSAGE_TAGS.RECEIPT, async (node) => {
        options.emitIncomingReceipt({
            ...buildBaseEvent(node),
            participant: node.attrs.participant,
            recipient: node.attrs.recipient
        })

        try {
            await options.trackOutboundReceipt?.(node)
        } catch (error) {
            options.logger.warn('failed to track outbound message receipt state', {
                id: node.attrs.id,
                from: node.attrs.from,
                type: node.attrs.type,
                message: toError(error).message
            })
        }

        const receiptType = node.attrs.type
        if (!node.attrs.id || !node.attrs.from) {
            options.logger.warn('incoming receipt missing required attrs for ack', {
                hasFrom: node.attrs.from !== undefined,
                hasId: node.attrs.id !== undefined,
                type: receiptType
            })
            return
        }

        if (receiptType === 'retry' || receiptType === 'enc_rekey_retry') {
            if (options.handleIncomingRetryReceipt) {
                await options.handleIncomingRetryReceipt(node)
            } else {
                await sendSafeAck(
                    options.logger,
                    options.sendNode,
                    buildInboundRetryReceiptAckNode(node)
                )
            }
            return
        }

        await sendSafeAck(options.logger, options.sendNode, buildInboundReceiptAckNode(node))
    })
}

export function createIncomingPresenceHandler(
    options: IncomingNodeHandlerOptions
): (node: BinaryNode) => Promise<boolean> {
    return createSimpleIncomingHandler('presence', (node) => {
        options.emitIncomingPresence(buildBaseEvent(node))
    })
}

export function createIncomingChatstateHandler(
    options: IncomingNodeHandlerOptions
): (node: BinaryNode) => Promise<boolean> {
    return createSimpleIncomingHandler('chatstate', (node) => {
        options.emitIncomingChatstate({
            ...buildBaseEvent(node),
            participant: node.attrs.participant
        })
    })
}

export function createIncomingCallHandler(
    options: IncomingNodeHandlerOptions
): (node: BinaryNode) => Promise<boolean> {
    return createSimpleIncomingHandler('call', (node) => {
        options.emitIncomingCall(buildBaseEvent(node))
    })
}

export function createIncomingErrorStanzaHandler(
    options: IncomingNodeHandlerOptions
): (node: BinaryNode) => Promise<boolean> {
    return createSimpleIncomingHandler(WA_NODE_TAGS.ERROR, (node) => {
        options.emitIncomingErrorStanza(buildBaseEvent(node))
    })
}

export function createIncomingFailureHandler(
    options: IncomingNodeHandlerOptions
): (node: BinaryNode) => Promise<boolean> {
    return createSimpleIncomingHandler('failure', async (node) => {
        const reason = parseOptionalInt(node.attrs.reason)
        const code = parseOptionalInt(node.attrs.code)
        options.emitIncomingFailure({
            ...buildBaseEvent(node),
            reason,
            code,
            message: node.attrs.message,
            url: node.attrs.url
        })

        if (reason !== undefined && LOGOUT_FAILURE_REASONS.has(reason)) {
            try {
                await options.disconnect()
                await options.clearStoredCredentials()
            } catch (error) {
                options.logger.warn('failed applying logout flow for failure stanza', {
                    reason,
                    message: toError(error).message
                })
            }
            return
        }

        if (reason !== undefined && DISCONNECT_FAILURE_REASONS.has(reason)) {
            try {
                await options.disconnect()
            } catch (error) {
                options.logger.warn('failed applying disconnect flow for failure stanza', {
                    reason,
                    message: toError(error).message
                })
            }
            return
        }
    })
}

export function createIncomingNotificationHandler(
    options: IncomingNodeHandlerOptions
): (node: BinaryNode) => Promise<boolean> {
    return createSimpleIncomingHandler(WA_NODE_TAGS.NOTIFICATION, async (node) => {
        const notificationType = node.attrs.type ?? ''
        const classification = classifyNotificationType(notificationType)
        emitIncomingNotificationEvent(options, node, notificationType, classification)

        if (classification === 'out_of_scope') {
            options.emitUnhandledStanza({
                ...buildBaseEvent(node),
                reason: `notification.${notificationType}.out_of_scope`
            })
        } else if (classification === 'unknown') {
            options.emitUnhandledStanza({
                ...buildBaseEvent(node),
                reason: `notification.${notificationType || 'unknown'}.not_supported`
            })
        }

        await sendSafeAck(options.logger, options.sendNode, buildNotificationAckNode(node))
    })
}

export function createInfoBulletinNotificationEvent(
    node: BinaryNode,
    type: string,
    details?: Readonly<Record<string, unknown>>
): WaIncomingNotificationEvent {
    return {
        ...buildBaseEvent(node),
        notificationType: `ib.${type}`,
        classification: 'info_bulletin',
        details
    }
}

export function createUnhandledIncomingNodeEvent(
    node: BinaryNode,
    reason = `unhandled.${node.tag}`
): WaIncomingUnhandledStanzaEvent {
    return {
        ...buildBaseEvent(node),
        reason
    }
}
