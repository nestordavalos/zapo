import type { Logger } from '../../infra/log/types'
import type { BinaryNode } from '../types'

export interface WaNodeTransportEventMap {
    readonly frame_in: (frame: Uint8Array) => void
    readonly frame_out: (frame: Uint8Array) => void
    readonly node_in: (node: BinaryNode, frame: Uint8Array) => void
    readonly node_out: (node: BinaryNode, frame: Uint8Array) => void
    readonly decode_error: (error: Error, frame: Uint8Array) => void
}

export type WaIqSetNodeHandler = (node: BinaryNode) => Promise<boolean>
export type WaNotificationNodeHandler = (node: BinaryNode) => Promise<boolean>
export type WaMessageNodeHandler = (node: BinaryNode) => Promise<boolean>

export interface PendingNodeQuery {
    readonly resolve: (value: BinaryNode) => void
    readonly reject: (error: Error) => void
    readonly timer: NodeJS.Timeout
}

export interface WaNodeOrchestratorOptions {
    readonly logger: Logger
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly defaultTimeoutMs?: number
    readonly hostDomain?: string
}

export interface WaIncomingNodeRouterOptions {
    readonly nodeOrchestrator: {
        tryResolvePending(node: BinaryNode): boolean
        handleIncomingNode(node: BinaryNode): Promise<boolean>
    }
    readonly iqSetHandlers?: readonly WaIqSetNodeHandler[]
    readonly notificationHandlers?: readonly WaNotificationNodeHandler[]
    readonly messageHandlers?: readonly WaMessageNodeHandler[]
}
