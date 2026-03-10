import type { WaSuccessPersistAttributes } from '../../auth/types'
import type { Logger } from '../../infra/log/types'
import {
    decodeBinaryNodeContent,
    findNodeChild,
    getNodeChildrenByTag
} from '../../transport/node/helpers'
import {
    parseStreamControlNode,
    parseSuccessPersistAttributes
} from '../../transport/stream/parse'
import type { WaStreamControlNodeResult } from '../../transport/stream/types'
import type { BinaryNode } from '../../transport/types'
import { toError } from '../../util/errors'
import {
    INFO_BULLETIN_DIRTY_TAG,
    INFO_BULLETIN_EDGE_ROUTING_TAG,
    INFO_BULLETIN_NODE_TAG,
    INFO_BULLETIN_ROUTING_INFO_TAG,
    SUCCESS_NODE_TAG
} from '../constants'
import type { WaDirtyBit } from '../sync/types'

export interface WaIncomingNodeCoordinatorOptions {
    readonly logger: Logger
    readonly handleStreamControlResult: (result: WaStreamControlNodeResult) => Promise<void>
    readonly persistSuccessAttributes: (attributes: WaSuccessPersistAttributes) => Promise<void>
    readonly emitSuccessNode: (node: BinaryNode) => void
    readonly updateClockSkewFromSuccess: (serverUnixSeconds: number) => void
    readonly shouldWarmupMediaConn: () => boolean
    readonly warmupMediaConn: () => Promise<void>
    readonly parseDirtyBits: (nodes: readonly BinaryNode[]) => readonly WaDirtyBit[]
    readonly handleDirtyBits: (dirtyBits: readonly WaDirtyBit[]) => Promise<void>
    readonly persistRoutingInfo: (routingInfo: Uint8Array) => Promise<void>
    readonly dispatchIncomingNode: (node: BinaryNode) => Promise<unknown>
}

export class WaIncomingNodeCoordinator {
    private readonly logger: Logger
    private readonly handleStreamControlResult: (result: WaStreamControlNodeResult) => Promise<void>
    private readonly persistSuccessAttributes: (
        attributes: WaSuccessPersistAttributes
    ) => Promise<void>
    private readonly emitSuccessNode: (node: BinaryNode) => void
    private readonly updateClockSkewFromSuccess: (serverUnixSeconds: number) => void
    private readonly shouldWarmupMediaConn: () => boolean
    private readonly warmupMediaConn: () => Promise<void>
    private readonly parseDirtyBits: (nodes: readonly BinaryNode[]) => readonly WaDirtyBit[]
    private readonly handleDirtyBits: (dirtyBits: readonly WaDirtyBit[]) => Promise<void>
    private readonly persistRoutingInfo: (routingInfo: Uint8Array) => Promise<void>
    private readonly dispatchIncomingNode: (node: BinaryNode) => Promise<unknown>
    private mediaConnWarmupPromise: Promise<void> | null

    public constructor(options: WaIncomingNodeCoordinatorOptions) {
        this.logger = options.logger
        this.handleStreamControlResult = options.handleStreamControlResult
        this.persistSuccessAttributes = options.persistSuccessAttributes
        this.emitSuccessNode = options.emitSuccessNode
        this.updateClockSkewFromSuccess = options.updateClockSkewFromSuccess
        this.shouldWarmupMediaConn = options.shouldWarmupMediaConn
        this.warmupMediaConn = options.warmupMediaConn
        this.parseDirtyBits = options.parseDirtyBits
        this.handleDirtyBits = options.handleDirtyBits
        this.persistRoutingInfo = options.persistRoutingInfo
        this.dispatchIncomingNode = options.dispatchIncomingNode
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
            await this.handleStreamControlResult(streamControlResult)
            return
        }
        if (await this.handleSuccessNode(node)) {
            return
        }
        if (await this.handleInfoBulletinNode(node)) {
            return
        }
        await this.dispatchIncomingNode(node)
    }

    private async handleSuccessNode(node: BinaryNode): Promise<boolean> {
        if (node.tag !== SUCCESS_NODE_TAG) {
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
        this.emitSuccessNode(node)
        if (persistAttributes.lastSuccessTs !== undefined) {
            this.updateClockSkewFromSuccess(persistAttributes.lastSuccessTs)
        }
        await this.persistSuccessAttributes(persistAttributes)
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
        if (!this.shouldWarmupMediaConn()) {
            return
        }
        await this.warmupMediaConn()
    }

    private async handleInfoBulletinNode(node: BinaryNode): Promise<boolean> {
        if (node.tag !== INFO_BULLETIN_NODE_TAG) {
            return false
        }
        const edgeRoutingNode = findNodeChild(node, INFO_BULLETIN_EDGE_ROUTING_TAG)
        if (edgeRoutingNode) {
            await this.handleEdgeRoutingInfoNode(edgeRoutingNode)
        }

        const dirtyNodes = getNodeChildrenByTag(node, INFO_BULLETIN_DIRTY_TAG)
        const dirtyBits = this.parseDirtyBits(dirtyNodes)
        if (dirtyBits.length > 0) {
            await this.handleDirtyBits(dirtyBits)
        }
        return edgeRoutingNode !== undefined || dirtyBits.length > 0
    }

    private async handleEdgeRoutingInfoNode(edgeRoutingNode: BinaryNode): Promise<void> {
        const routingInfoNode = findNodeChild(edgeRoutingNode, INFO_BULLETIN_ROUTING_INFO_TAG)
        if (!routingInfoNode) {
            return
        }
        try {
            const routingInfo = decodeBinaryNodeContent(
                routingInfoNode.content,
                `ib.${INFO_BULLETIN_EDGE_ROUTING_TAG}.${INFO_BULLETIN_ROUTING_INFO_TAG}`
            )
            await this.persistRoutingInfo(routingInfo)
            this.logger.info('updated routing info from info bulletin', {
                byteLength: routingInfo.byteLength
            })
        } catch (error) {
            this.logger.warn('failed to process routing info from info bulletin', {
                message: toError(error).message
            })
        }
    }
}
