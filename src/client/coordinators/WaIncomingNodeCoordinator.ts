import type { WaSuccessPersistAttributes } from '@auth/types'
import type { WaDirtyBit } from '@client/dirty'
import {
    createIncomingCallHandler,
    createIncomingChatstateHandler,
    createIncomingErrorStanzaHandler,
    createIncomingFailureHandler,
    createIncomingNotificationHandler,
    createIncomingPresenceHandler,
    createIncomingReceiptHandler,
    createInfoBulletinNotificationEvent,
    createUnhandledIncomingNodeEvent
} from '@client/incoming'
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
import { WA_IQ_TYPES, WA_MESSAGE_TAGS, WA_NODE_TAGS } from '@protocol/constants'
import {
    decodeBinaryNodeContent,
    findNodeChild,
    getNodeChildrenByTag
} from '@transport/node/helpers'
import {
    parseOptionalInt,
    parseStreamControlNode,
    parseSuccessPersistAttributes,
    type WaStreamControlNodeResult
} from '@transport/stream/parse'
import type { BinaryNode } from '@transport/types'
import { toError } from '@util/primitives'

interface WaIncomingNodeRuntimePort {
    readonly handleStreamControlResult: (result: WaStreamControlNodeResult) => Promise<void>
    readonly persistSuccessAttributes: (attributes: WaSuccessPersistAttributes) => Promise<void>
    readonly emitSuccessNode: (node: BinaryNode) => void
    readonly updateClockSkewFromSuccess: (serverUnixSeconds: number) => void
    readonly shouldWarmupMediaConn: () => boolean
    readonly warmupMediaConn: () => Promise<void>
    readonly persistRoutingInfo: (routingInfo: Uint8Array) => Promise<void>
    readonly tryResolvePendingNode: (node: BinaryNode) => boolean
    readonly handleGenericIncomingNode: (node: BinaryNode) => Promise<boolean>
    readonly handleIncomingIqSetNode: (node: BinaryNode) => Promise<boolean>
    readonly handleLinkCodeNotificationNode: (node: BinaryNode) => Promise<boolean>
    readonly handleCompanionRegRefreshNotificationNode: (node: BinaryNode) => Promise<boolean>
    readonly handleIncomingMessageNode: (node: BinaryNode) => Promise<boolean>
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly handleIncomingRetryReceipt: (node: BinaryNode) => Promise<void>
    readonly trackOutboundReceipt: (node: BinaryNode) => Promise<void>
    readonly emitIncomingReceipt: (event: WaIncomingReceiptEvent) => void
    readonly emitIncomingPresence: (event: WaIncomingPresenceEvent) => void
    readonly emitIncomingChatstate: (event: WaIncomingChatstateEvent) => void
    readonly emitIncomingCall: (event: WaIncomingCallEvent) => void
    readonly emitIncomingFailure: (event: WaIncomingFailureEvent) => void
    readonly emitIncomingErrorStanza: (event: WaIncomingBaseEvent) => void
    readonly emitIncomingNotification: (event: WaIncomingNotificationEvent) => void
    readonly emitUnhandledIncomingNode: (event: WaIncomingUnhandledStanzaEvent) => void
    readonly disconnect: () => Promise<void>
    readonly clearStoredCredentials: () => Promise<void>
}

interface WaIncomingNodeDirtySyncPort {
    readonly parseDirtyBits: (nodes: readonly BinaryNode[]) => readonly WaDirtyBit[]
    readonly handleDirtyBits: (dirtyBits: readonly WaDirtyBit[]) => Promise<void>
}

interface WaIncomingNodeCoordinatorOptions {
    readonly logger: Logger
    readonly runtime: WaIncomingNodeRuntimePort
    readonly dirtySync: WaIncomingNodeDirtySyncPort
}

type IncomingNodeHandler = (node: BinaryNode) => Promise<boolean>
type IncomingNodeHandlersByTag = Readonly<Record<string, readonly IncomingNodeHandler[]>>

export class WaIncomingNodeCoordinator {
    private readonly logger: Logger
    private readonly runtime: WaIncomingNodeRuntimePort
    private readonly dirtySync: WaIncomingNodeDirtySyncPort
    private readonly nodeHandlers: IncomingNodeHandlersByTag
    private mediaConnWarmupPromise: Promise<void> | null

    public constructor(options: WaIncomingNodeCoordinatorOptions) {
        this.logger = options.logger
        this.runtime = options.runtime
        this.dirtySync = options.dirtySync
        this.nodeHandlers = this.createIncomingNodeHandlers()
        this.mediaConnWarmupPromise = null
    }

    public async handleIncomingNode(node: BinaryNode): Promise<void> {
        this.logger.trace('wa client incoming node', {
            tag: node.tag,
            id: node.attrs.id,
            type: node.attrs.type
        })
        const streamControlResult = parseStreamControlNode(node)
        if (streamControlResult) {
            await this.runtime.handleStreamControlResult(streamControlResult)
            return
        }
        if (await this.handleSuccessNode(node)) {
            return
        }
        if (await this.handleInfoBulletinNode(node)) {
            return
        }
        const handled = await this.dispatchIncomingNode(node)
        if (handled) {
            return
        }
        this.runtime.emitUnhandledIncomingNode(createUnhandledIncomingNodeEvent(node))
    }

    private async dispatchIncomingNode(node: BinaryNode): Promise<boolean> {
        if (node.tag === WA_MESSAGE_TAGS.RECEIPT) {
            const handlers = this.nodeHandlers[node.tag]
            if (handlers) {
                for (const handler of handlers) {
                    if (await handler(node)) {
                        this.runtime.tryResolvePendingNode(node)
                        return true
                    }
                }
            }
            return this.runtime.tryResolvePendingNode(node)
        }

        if (this.runtime.tryResolvePendingNode(node)) {
            return true
        }

        const genericHandled = await this.runtime.handleGenericIncomingNode(node)
        if (genericHandled) {
            return true
        }

        const handlers = this.nodeHandlers[node.tag]
        if (!handlers || handlers.length === 0) {
            return false
        }

        for (const handler of handlers) {
            if (await handler(node)) {
                return true
            }
        }
        return false
    }

    private createIncomingNodeHandlers(): IncomingNodeHandlersByTag {
        const incomingNodeHandlerOptions = {
            logger: this.logger,
            sendNode: (node: BinaryNode) => this.runtime.sendNode(node),
            handleIncomingRetryReceipt: (node: BinaryNode) =>
                this.runtime.handleIncomingRetryReceipt(node),
            trackOutboundReceipt: (node: BinaryNode) => this.runtime.trackOutboundReceipt(node),
            emitIncomingReceipt: (event: WaIncomingReceiptEvent) =>
                this.runtime.emitIncomingReceipt(event),
            emitIncomingPresence: (event: WaIncomingPresenceEvent) =>
                this.runtime.emitIncomingPresence(event),
            emitIncomingChatstate: (event: WaIncomingChatstateEvent) =>
                this.runtime.emitIncomingChatstate(event),
            emitIncomingCall: (event: WaIncomingCallEvent) => this.runtime.emitIncomingCall(event),
            emitIncomingFailure: (event: WaIncomingFailureEvent) =>
                this.runtime.emitIncomingFailure(event),
            emitIncomingErrorStanza: (event: WaIncomingBaseEvent) =>
                this.runtime.emitIncomingErrorStanza(event),
            emitIncomingNotification: (event: WaIncomingNotificationEvent) =>
                this.runtime.emitIncomingNotification(event),
            emitUnhandledStanza: (event: WaIncomingUnhandledStanzaEvent) =>
                this.runtime.emitUnhandledIncomingNode(event),
            disconnect: async () => this.runtime.disconnect(),
            clearStoredCredentials: async () => this.runtime.clearStoredCredentials()
        } as const

        const iqSetHandlers = [
            async (node: BinaryNode) => this.runtime.handleIncomingIqSetNode(node)
        ]
        const notificationHandlers = [
            async (node: BinaryNode) => this.runtime.handleLinkCodeNotificationNode(node),
            async (node: BinaryNode) =>
                this.runtime.handleCompanionRegRefreshNotificationNode(node),
            createIncomingNotificationHandler(incomingNodeHandlerOptions)
        ] as const
        const messageHandlers = [
            async (node: BinaryNode) => this.runtime.handleIncomingMessageNode(node)
        ] as const

        return {
            [WA_NODE_TAGS.IQ]: [
                async (node) => {
                    if (node.attrs.type !== WA_IQ_TYPES.SET) {
                        return false
                    }
                    for (const handler of iqSetHandlers) {
                        if (await handler(node)) {
                            return true
                        }
                    }
                    return false
                }
            ],
            [WA_NODE_TAGS.NOTIFICATION]: notificationHandlers,
            [WA_MESSAGE_TAGS.MESSAGE]: messageHandlers,
            [WA_MESSAGE_TAGS.RECEIPT]: [createIncomingReceiptHandler(incomingNodeHandlerOptions)],
            presence: [createIncomingPresenceHandler(incomingNodeHandlerOptions)],
            chatstate: [createIncomingChatstateHandler(incomingNodeHandlerOptions)],
            call: [createIncomingCallHandler(incomingNodeHandlerOptions)],
            failure: [createIncomingFailureHandler(incomingNodeHandlerOptions)],
            [WA_NODE_TAGS.ERROR]: [createIncomingErrorStanzaHandler(incomingNodeHandlerOptions)]
        }
    }

    private async handleSuccessNode(node: BinaryNode): Promise<boolean> {
        if (node.tag !== WA_NODE_TAGS.SUCCESS) {
            return false
        }

        const persistAttributes = parseSuccessPersistAttributes(node, (error) => {
            this.logger.warn('invalid companion_enc_static in success node', {
                message: error.message
            })
        })
        this.logger.info('received success node', {
            t: node.attrs.t,
            props: node.attrs.props,
            abprops: node.attrs.abprops,
            location: node.attrs.location,
            hasCompanionEncStatic: persistAttributes.companionEncStatic !== undefined,
            meLid: persistAttributes.meLid,
            meDisplayName: persistAttributes.meDisplayName
        })
        this.runtime.emitSuccessNode(node)
        if (persistAttributes.lastSuccessTs !== undefined) {
            this.runtime.updateClockSkewFromSuccess(persistAttributes.lastSuccessTs)
        }
        await this.runtime.persistSuccessAttributes(persistAttributes)
        this.scheduleMediaConnWarmup()
        return true
    }

    private scheduleMediaConnWarmup(): void {
        if (this.mediaConnWarmupPromise) {
            return
        }
        this.mediaConnWarmupPromise = this.warmupMediaConnAfterSuccess()
            .then(() => {
                this.logger.debug('post-login media_conn warmup completed')
            })
            .catch((error) => {
                this.logger.warn('post-login media_conn warmup failed', {
                    message: toError(error).message
                })
            })
            .finally(() => {
                this.mediaConnWarmupPromise = null
            })
    }

    private async warmupMediaConnAfterSuccess(): Promise<void> {
        if (!this.runtime.shouldWarmupMediaConn()) {
            return
        }
        await this.runtime.warmupMediaConn()
    }

    private async handleInfoBulletinNode(node: BinaryNode): Promise<boolean> {
        if (node.tag !== WA_NODE_TAGS.INFO_BULLETIN) {
            return false
        }
        let handled = false

        const ibType = node.attrs.type
        if (ibType) {
            if (this.emitInfoBulletinTypeNotification(node, ibType)) {
                handled = true
            }
        }

        const edgeRoutingNode = findNodeChild(node, WA_NODE_TAGS.EDGE_ROUTING)
        if (edgeRoutingNode) {
            await this.handleEdgeRoutingInfoNode(edgeRoutingNode)
            handled = true
        }

        const dirtyNodes = getNodeChildrenByTag(node, WA_NODE_TAGS.DIRTY)
        const dirtyBits = this.dirtySync.parseDirtyBits(dirtyNodes)
        if (dirtyBits.length > 0) {
            void this.dirtySync.handleDirtyBits(dirtyBits).catch((error) => {
                this.logger.warn('dirty bits sync failed', {
                    message: toError(error).message
                })
            })
            handled = true
        }
        return handled
    }

    private async handleEdgeRoutingInfoNode(edgeRoutingNode: BinaryNode): Promise<void> {
        const routingInfoNode = findNodeChild(edgeRoutingNode, WA_NODE_TAGS.ROUTING_INFO)
        if (!routingInfoNode) {
            return
        }
        try {
            const routingInfo = decodeBinaryNodeContent(
                routingInfoNode.content,
                `ib.${WA_NODE_TAGS.EDGE_ROUTING}.${WA_NODE_TAGS.ROUTING_INFO}`
            )
            await this.runtime.persistRoutingInfo(routingInfo)
            this.logger.info('updated routing info from info bulletin', {
                byteLength: routingInfo.byteLength
            })
        } catch (error) {
            this.logger.warn('failed to process routing info from info bulletin', {
                message: toError(error).message
            })
        }
    }

    private emitInfoBulletinTypeNotification(node: BinaryNode, ibType: string): boolean {
        switch (ibType) {
            case 'offline':
            case 'offline_preview':
            case 'priority_offline_complete':
            case 'tos':
            case 'thread_metadata':
            case 'client_expiration':
                this.runtime.emitIncomingNotification(
                    createInfoBulletinNotificationEvent(node, ibType, {
                        count: parseOptionalInt(node.attrs.count),
                        t: parseOptionalInt(node.attrs.t)
                    })
                )
                return true
            default:
                return false
        }
    }
}
