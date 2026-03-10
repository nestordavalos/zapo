import type { Logger } from '../infra/log/types'
import type { Proto } from '../proto'
import type { BinaryNode } from '../transport/types'

export type AppStateCollectionName =
    | 'regular'
    | 'regular_low'
    | 'regular_high'
    | 'critical_block'
    | 'critical_unblock_low'

export type AppStateCollectionState =
    | 'success'
    | 'success_has_more'
    | 'conflict'
    | 'conflict_has_more'
    | 'error_retry'
    | 'error_fatal'
    | 'blocked'

export type AppStateMutationOperation = 'set' | 'remove'

export interface WaAppStateSyncKey {
    readonly keyId: Uint8Array
    readonly keyData: Uint8Array
    readonly timestamp: number
    readonly fingerprint?: Proto.Message.IAppStateSyncKeyFingerprint
}

export interface WaAppStateCollectionVersion {
    readonly version: number
    readonly hash: Uint8Array
    readonly indexValueMap: Readonly<Record<string, Uint8Array>>
}

export interface WaAppStateStoreData {
    readonly keys: readonly WaAppStateSyncKey[]
    readonly collections: Partial<Record<AppStateCollectionName, WaAppStateCollectionVersion>>
}

export interface WaAppStateSetMutationInput {
    readonly collection: AppStateCollectionName
    readonly operation: 'set'
    readonly index: string
    readonly value: Proto.ISyncActionValue
    readonly version: number
    readonly timestamp: number
}

export interface WaAppStateRemoveMutationInput {
    readonly collection: AppStateCollectionName
    readonly operation: 'remove'
    readonly index: string
    readonly previousValue: Proto.ISyncActionValue
    readonly version: number
    readonly timestamp: number
}

export type WaAppStateMutationInput = WaAppStateSetMutationInput | WaAppStateRemoveMutationInput

export interface WaAppStateMutation {
    readonly collection: AppStateCollectionName
    readonly operation: AppStateMutationOperation
    readonly index: string
    readonly value: Proto.ISyncActionValue | null
    readonly version: number
    readonly indexMac: Uint8Array
    readonly valueMac: Uint8Array
    readonly keyId: Uint8Array
    readonly timestamp: number
}

export interface WaAppStateCollectionSyncResult {
    readonly collection: AppStateCollectionName
    readonly state: AppStateCollectionState
    readonly version?: number
    readonly mutations?: readonly WaAppStateMutation[]
}

export interface WaAppStateSyncResult {
    readonly collections: readonly WaAppStateCollectionSyncResult[]
}

export interface WaAppStateExternalBlobDownloader {
    (
        collection: AppStateCollectionName,
        kind: 'snapshot' | 'patch',
        reference: Proto.IExternalBlobReference
    ): Promise<Uint8Array>
}

export interface WaAppStateDerivedKeys {
    readonly indexKey: Uint8Array
    readonly valueEncryptionKey: Uint8Array
    readonly valueMacKey: Uint8Array
    readonly snapshotMacKey: Uint8Array
    readonly patchMacKey: Uint8Array
}

export interface WaAppStateEncryptedMutation {
    readonly indexMac: Uint8Array
    readonly valueBlob: Uint8Array
    readonly valueMac: Uint8Array
}

export interface WaAppStateDecryptedMutation {
    readonly index: string
    readonly value: Proto.ISyncActionValue | null
    readonly version: number
    readonly indexMac: Uint8Array
    readonly valueMac: Uint8Array
}

export interface CollectionResponsePayload {
    readonly collection: AppStateCollectionName
    readonly state: AppStateCollectionState
    readonly version?: number
    readonly patches: readonly Proto.ISyncdPatch[]
    readonly snapshotReference?: Proto.IExternalBlobReference
}

export interface OutgoingPatchContext {
    readonly collection: AppStateCollectionName
    readonly patchVersion: number
    readonly nextHash: Uint8Array
    readonly nextIndexValueMap: Map<string, Uint8Array>
}

export interface MacMutation {
    readonly operation: number
    readonly indexMac: Uint8Array
    readonly valueMac: Uint8Array
}

export interface WaAppStateSyncClientOptions {
    readonly logger: Logger
    readonly query: (node: BinaryNode, timeoutMs: number) => Promise<BinaryNode>
    readonly getPersistedAppState: () => WaAppStateStoreData | undefined
    readonly persistAppState: (next: WaAppStateStoreData) => Promise<void>
    readonly hostDomain?: string
    readonly defaultTimeoutMs?: number
}

export interface WaAppStateSyncOptions {
    readonly collections?: readonly AppStateCollectionName[]
    readonly pendingMutations?: readonly WaAppStateMutationInput[]
    readonly downloadExternalBlob?: WaAppStateExternalBlobDownloader
    readonly timeoutMs?: number
}

export interface MutableCollectionState {
    version: number
    hash: Uint8Array
    indexValueMap: Map<string, Uint8Array>
}
