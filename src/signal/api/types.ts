import type { Logger } from '../../infra/log/types'
import type { BinaryNode } from '../../transport/types'
import type { SignalPreKeyBundle } from '../types'

export interface SignalSessionSyncApiOptions {
    readonly logger: Logger
    readonly query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
    readonly defaultTimeoutMs?: number
    readonly hostDomain?: string
}

export interface SignalFetchKeyBundleTarget {
    readonly jid: string
    readonly reasonIdentity?: boolean
}

export interface SignalFetchedKeyBundle {
    readonly jid: string
    readonly bundle: SignalPreKeyBundle
    readonly deviceIdentity?: Uint8Array
}

