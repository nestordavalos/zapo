import type { Logger } from '../../infra/log/types'
import type { BinaryNode } from '../types'
import type { WaComms } from '../WaComms'

export interface WaKeepAliveOptions {
    readonly logger: Logger
    readonly nodeOrchestrator: {
        hasPending(): boolean
        query(node: BinaryNode, timeoutMs?: number): Promise<BinaryNode>
    }
    readonly getComms: () => WaComms | null
    readonly intervalMs?: number
    readonly timeoutMs?: number
    readonly hostDomain?: string
}
