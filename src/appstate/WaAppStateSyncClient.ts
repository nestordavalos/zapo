import { APP_STATE_DEFAULT_COLLECTIONS, APP_STATE_EMPTY_LT_HASH } from '@appstate/constants'
import type {
    AppStateCollectionName,
    WaAppStateCollectionSyncResult,
    WaAppStateMutation,
    WaAppStateMutationInput,
    WaAppStateSyncOptions,
    WaAppStateStoreData,
    WaAppStateSyncResult,
    WaAppStateSyncKey
} from '@appstate/types'
import { keyIdToHex } from '@appstate/utils'
import { WaAppStateCrypto } from '@appstate/WaAppStateCrypto'
import {
    type CollectionResponsePayload,
    parseSyncResponse
} from '@appstate/WaAppStateSyncResponseParser'
import type { Logger } from '@infra/log/types'
import { proto } from '@proto'
import type { Proto } from '@proto'
import {
    WA_APP_STATE_COLLECTION_STATES,
    WA_DEFAULTS,
    WA_IQ_TYPES,
    WA_NODE_TAGS,
    WA_XMLNS
} from '@protocol/constants'
import type {
    WaAppStateCollectionStateUpdate,
    WaAppStateCollectionStoreState,
    WaAppStateStore
} from '@store/contracts/appstate.store'
import type { BinaryNode } from '@transport/types'
import { decodeProtoBytes } from '@util/base64'
import { uint8Equal } from '@util/bytes'
import { longToNumber } from '@util/primitives'

interface OutgoingPatchContext {
    readonly collection: AppStateCollectionName
    readonly patchVersion: number
    readonly nextHash: Uint8Array
    readonly nextIndexValueMap: Map<string, Uint8Array>
}

interface MacMutation {
    readonly operation: number
    readonly indexMac: Uint8Array
    readonly valueMac: Uint8Array
}

interface DecryptedSnapshotRecord {
    readonly decrypted: Awaited<ReturnType<WaAppStateCrypto['decryptMutation']>>
    readonly recordKeyId: Uint8Array
}

type DecryptedPatchMutation = WaAppStateMutation & { operationCode: number }

interface WaAppStateSyncClientOptions {
    readonly logger: Logger
    readonly query: (node: BinaryNode, timeoutMs: number) => Promise<BinaryNode>
    readonly store: WaAppStateStore
    readonly hostDomain?: string
    readonly defaultTimeoutMs?: number
}

interface WaAppStateSyncContext {
    readonly keys: Map<string, Uint8Array | null>
    readonly collections: Map<AppStateCollectionName, WaAppStateCollectionStoreState>
    readonly dirtyCollections: Set<AppStateCollectionName>
}

interface SyncRoundResult {
    readonly results: readonly WaAppStateCollectionSyncResult[]
    readonly collectionsToRefetch: readonly AppStateCollectionName[]
    readonly stateChanged: boolean
}

interface PreparedCollectionRequest {
    readonly collection: AppStateCollectionName
    readonly node: BinaryNode
    readonly outgoingContext?: OutgoingPatchContext
    readonly skippedUpload: boolean
}

interface PreparedSyncRoundRequest {
    readonly collectionNodes: readonly BinaryNode[]
    readonly outgoingContexts: ReadonlyMap<AppStateCollectionName, OutgoingPatchContext>
    readonly skippedUploadCollections: ReadonlySet<AppStateCollectionName>
}

interface CollectionSyncOutcome {
    readonly collection: AppStateCollectionName
    readonly shouldRefetch: boolean
    readonly stateChanged: boolean
    readonly result: WaAppStateCollectionSyncResult
}

interface ProtoLongLike {
    toNumber(): number
}

function isProtoLongLike(value: unknown): value is ProtoLongLike {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { toNumber?: unknown }).toNumber === 'function'
    )
}

export class WaAppStateMissingKeyError extends Error {
    public constructor(message: string) {
        super(message)
        this.name = 'WaAppStateMissingKeyError'
    }
}

export class WaAppStateSyncClient {
    private readonly logger: Logger
    private readonly query: (node: BinaryNode, timeoutMs: number) => Promise<BinaryNode>
    private readonly store: WaAppStateStore
    private readonly hostDomain: string
    private readonly defaultTimeoutMs: number
    private readonly crypto: WaAppStateCrypto
    private syncPromise: Promise<WaAppStateSyncResult> | null

    public constructor(options: WaAppStateSyncClientOptions) {
        this.logger = options.logger
        this.query = options.query
        this.store = options.store
        this.hostDomain = options.hostDomain ?? WA_DEFAULTS.HOST_DOMAIN
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? WA_DEFAULTS.APP_STATE_SYNC_TIMEOUT_MS

        this.crypto = new WaAppStateCrypto()
        this.syncPromise = null
    }

    public async exportState(): Promise<WaAppStateStoreData> {
        this.logger.trace('app-state export requested')
        return this.store.exportData()
    }

    public async importSyncKeys(keys: readonly WaAppStateSyncKey[]): Promise<number> {
        this.logger.debug('app-state importing sync keys', { count: keys.length })
        const inserted = await this.store.upsertSyncKeys(keys)
        if (inserted > 0) {
            this.crypto.clearCache()
            this.logger.info('app-state sync keys persisted', { inserted })
        }
        return inserted
    }

    public async importSyncKeyShare(share: Proto.Message.IAppStateSyncKeyShare): Promise<number> {
        const keys: WaAppStateSyncKey[] = []
        for (const item of share.keys ?? []) {
            const keyId = decodeProtoBytes(
                item.keyId?.keyId,
                'appStateSyncKeyShare.keys[].keyId.keyId'
            )
            const keyData = decodeProtoBytes(
                item.keyData?.keyData,
                'appStateSyncKeyShare.keys[].keyData.keyData'
            )
            keys.push({
                keyId,
                keyData,
                timestamp: this.normalizeProtoLong(
                    item.keyData?.timestamp,
                    'appStateSyncKeyShare.keys[].keyData.timestamp'
                ),
                fingerprint: item.keyData?.fingerprint ?? undefined
            })
        }
        return this.importSyncKeys(keys)
    }

    public async sync(options: WaAppStateSyncOptions = {}): Promise<WaAppStateSyncResult> {
        if (this.syncPromise) {
            this.logger.debug('app-state sync already in flight, joining existing run')
            return this.syncPromise
        }
        const inFlight = this.syncOnce(options)
        this.syncPromise = inFlight
        try {
            return await inFlight
        } finally {
            if (this.syncPromise === inFlight) {
                this.syncPromise = null
            }
        }
    }

    private async syncOnce(options: WaAppStateSyncOptions = {}): Promise<WaAppStateSyncResult> {
        const context: WaAppStateSyncContext = {
            keys: new Map(),
            collections: new Map(),
            dirtyCollections: new Set()
        }
        const collections = [
            ...new Set<AppStateCollectionName>(options.collections ?? APP_STATE_DEFAULT_COLLECTIONS)
        ]
        this.logger.info('app-state sync start', {
            collections: collections.length,
            pendingMutations: options.pendingMutations?.length ?? 0
        })
        const pendingByCollection = this.groupPendingMutations(options.pendingMutations ?? [])
        const resultMap = new Map<AppStateCollectionName, WaAppStateCollectionSyncResult>()
        let stateChanged = false
        let collectionsToSync = [...collections]
        const maxSyncIterations = 5
        let syncIteration = 0

        while (collectionsToSync.length > 0) {
            syncIteration += 1
            if (syncIteration > maxSyncIterations) {
                this.logger.warn('app-state sync reached max iterations', {
                    maxSyncIterations,
                    remainingCollections: collectionsToSync
                })
                for (const collection of collectionsToSync) {
                    resultMap.set(collection, {
                        collection,
                        state: WA_APP_STATE_COLLECTION_STATES.ERROR_RETRY
                    })
                }
                break
            }

            const round = await this.syncCollectionsRound(
                context,
                collectionsToSync,
                pendingByCollection,
                options
            )
            stateChanged = stateChanged || round.stateChanged
            for (const result of round.results) {
                resultMap.set(result.collection, result)
            }

            collectionsToSync = [...round.collectionsToRefetch]
            if (collectionsToSync.length > 0) {
                this.logger.debug('app-state scheduling refetch for collections', {
                    iteration: syncIteration,
                    collections: collectionsToSync
                })
            }
        }

        if (stateChanged && context.dirtyCollections.size > 0) {
            await this.persistCollectionUpdates(context)
            this.logger.info('app-state sync persisted updated state')
        }

        const orderedResults = collections.map((collection) => {
            const existing = resultMap.get(collection)
            if (existing) {
                return existing
            }
            return {
                collection,
                state: WA_APP_STATE_COLLECTION_STATES.ERROR_RETRY
            }
        })

        this.logger.info('app-state sync finished', {
            collections: orderedResults.length,
            stateChanged
        })
        return { collections: orderedResults }
    }

    private async syncCollectionsRound(
        context: WaAppStateSyncContext,
        collections: readonly AppStateCollectionName[],
        pendingByCollection: ReadonlyMap<
            AppStateCollectionName,
            readonly WaAppStateMutationInput[]
        >,
        options: WaAppStateSyncOptions
    ): Promise<SyncRoundResult> {
        const prepared = await this.prepareSyncRoundRequest(
            context,
            collections,
            pendingByCollection
        )
        const iqNode = this.buildSyncIqNode(prepared.collectionNodes)
        const payloadByCollection = await this.fetchSyncPayloadByCollection(
            iqNode,
            options.timeoutMs ?? this.defaultTimeoutMs
        )
        const collectionOutcomes = await Promise.all(
            collections.map((collection) =>
                this.processCollectionRound({
                    context,
                    collection,
                    payloadByCollection,
                    pendingByCollection,
                    options,
                    outgoingContexts: prepared.outgoingContexts,
                    skippedUploadCollections: prepared.skippedUploadCollections
                })
            )
        )
        return this.toSyncRoundResult(collectionOutcomes)
    }

    private async prepareSyncRoundRequest(
        context: WaAppStateSyncContext,
        collections: readonly AppStateCollectionName[],
        pendingByCollection: ReadonlyMap<AppStateCollectionName, readonly WaAppStateMutationInput[]>
    ): Promise<PreparedSyncRoundRequest> {
        const requests = await Promise.all(
            collections.map((collection) =>
                this.buildCollectionSyncRequest(context, collection, pendingByCollection)
            )
        )
        const outgoingContexts = new Map<AppStateCollectionName, OutgoingPatchContext>()
        const skippedUploadCollections = new Set<AppStateCollectionName>()
        for (const request of requests) {
            if (request.outgoingContext) {
                outgoingContexts.set(request.collection, request.outgoingContext)
            }
            if (request.skippedUpload) {
                skippedUploadCollections.add(request.collection)
            }
        }
        return {
            collectionNodes: requests.map((request) => request.node),
            outgoingContexts,
            skippedUploadCollections
        }
    }

    private async buildCollectionSyncRequest(
        context: WaAppStateSyncContext,
        collection: AppStateCollectionName,
        pendingByCollection: ReadonlyMap<AppStateCollectionName, readonly WaAppStateMutationInput[]>
    ): Promise<PreparedCollectionRequest> {
        const collectionState = await this.getCollectionState(context, collection)
        const hasPersistedState =
            collectionState.version > 0 ||
            collectionState.indexValueMap.size > 0 ||
            !uint8Equal(collectionState.hash, APP_STATE_EMPTY_LT_HASH)
        const attrs: Record<string, string> = {
            name: collection
        }
        if (hasPersistedState) {
            attrs.version = String(collectionState.version)
        } else {
            attrs.return_snapshot = 'true'
        }

        const children: BinaryNode[] = []
        const pendingMutations = pendingByCollection.get(collection) ?? []
        let outgoingContext: OutgoingPatchContext | undefined
        let skippedUpload = false
        if (pendingMutations.length > 0) {
            if (!hasPersistedState) {
                skippedUpload = true
                this.logger.debug(
                    'app-state skipped outgoing patch upload until snapshot bootstrap',
                    {
                        collection,
                        pendingMutations: pendingMutations.length
                    }
                )
            } else {
                const outgoing = await this.buildOutgoingPatch(
                    context,
                    collection,
                    collectionState,
                    pendingMutations
                )
                outgoingContext = outgoing.context
                children.push({
                    tag: WA_NODE_TAGS.PATCH,
                    attrs: {},
                    content: outgoing.encodedPatch
                })
            }
        }

        return {
            collection,
            outgoingContext,
            skippedUpload,
            node: {
                tag: WA_NODE_TAGS.COLLECTION,
                attrs,
                content: children.length > 0 ? children : undefined
            }
        }
    }

    private buildSyncIqNode(collectionNodes: readonly BinaryNode[]): BinaryNode {
        return {
            tag: WA_NODE_TAGS.IQ,
            attrs: {
                to: this.hostDomain,
                type: WA_IQ_TYPES.SET,
                xmlns: WA_XMLNS.APP_STATE_SYNC
            },
            content: [
                {
                    tag: WA_NODE_TAGS.SYNC,
                    attrs: {},
                    content: collectionNodes
                }
            ]
        }
    }

    private async fetchSyncPayloadByCollection(
        iqNode: BinaryNode,
        timeoutMs: number
    ): Promise<Map<AppStateCollectionName, CollectionResponsePayload>> {
        const responseNode = await this.query(iqNode, timeoutMs)
        this.logger.debug('app-state sync iq response received', {
            tag: responseNode.tag,
            type: responseNode.attrs.type
        })
        const payloads = parseSyncResponse(responseNode)
        this.logger.debug('app-state sync payloads parsed', { count: payloads.length })
        const payloadByCollection = new Map<AppStateCollectionName, CollectionResponsePayload>()
        for (const payload of payloads) {
            payloadByCollection.set(payload.collection, payload)
        }
        return payloadByCollection
    }

    private async processCollectionRound({
        context,
        collection,
        payloadByCollection,
        pendingByCollection,
        options,
        outgoingContexts,
        skippedUploadCollections
    }: {
        readonly context: WaAppStateSyncContext
        readonly collection: AppStateCollectionName
        readonly payloadByCollection: ReadonlyMap<AppStateCollectionName, CollectionResponsePayload>
        readonly pendingByCollection: ReadonlyMap<
            AppStateCollectionName,
            readonly WaAppStateMutationInput[]
        >
        readonly options: WaAppStateSyncOptions
        readonly outgoingContexts: ReadonlyMap<AppStateCollectionName, OutgoingPatchContext>
        readonly skippedUploadCollections: ReadonlySet<AppStateCollectionName>
    }): Promise<CollectionSyncOutcome> {
        const payload = payloadByCollection.get(collection)
        let shouldRefetch = false
        let collectionStateChanged = false

        if (!payload) {
            this.logger.warn('app-state sync response missing collection payload', { collection })
            return {
                collection,
                shouldRefetch,
                stateChanged: collectionStateChanged,
                result: {
                    collection,
                    state: WA_APP_STATE_COLLECTION_STATES.ERROR_RETRY
                }
            }
        }

        if (
            payload.state === WA_APP_STATE_COLLECTION_STATES.ERROR_FATAL ||
            payload.state === WA_APP_STATE_COLLECTION_STATES.ERROR_RETRY
        ) {
            return {
                collection,
                shouldRefetch,
                stateChanged: collectionStateChanged,
                result: {
                    collection,
                    state: payload.state,
                    version: payload.version
                }
            }
        }

        const pendingMutationsCount = pendingByCollection.get(collection)?.length ?? 0
        if (payload.state === WA_APP_STATE_COLLECTION_STATES.CONFLICT_HAS_MORE) {
            shouldRefetch = true
        } else if (
            payload.state === WA_APP_STATE_COLLECTION_STATES.CONFLICT &&
            pendingMutationsCount > 0
        ) {
            shouldRefetch = true
        }

        if (payload.state === WA_APP_STATE_COLLECTION_STATES.CONFLICT) {
            return {
                collection,
                shouldRefetch,
                stateChanged: collectionStateChanged,
                result: {
                    collection,
                    state:
                        pendingMutationsCount > 0
                            ? WA_APP_STATE_COLLECTION_STATES.CONFLICT
                            : WA_APP_STATE_COLLECTION_STATES.SUCCESS,
                    version: payload.version
                }
            }
        }

        if (payload.state === WA_APP_STATE_COLLECTION_STATES.CONFLICT_HAS_MORE) {
            return {
                collection,
                shouldRefetch,
                stateChanged: collectionStateChanged,
                result: {
                    collection,
                    state: payload.state,
                    version: payload.version
                }
            }
        }

        try {
            let appliedMutations: WaAppStateMutation[] = []
            if (payload.snapshotReference) {
                const downloader = options.downloadExternalBlob
                if (!downloader) {
                    throw new Error(
                        `snapshot for ${payload.collection} requires external blob downloader`
                    )
                }
                const snapshotBytes = await downloader(
                    payload.collection,
                    'snapshot',
                    payload.snapshotReference
                )
                const snapshot = this.validateSnapshot(
                    payload.collection,
                    proto.SyncdSnapshot.decode(snapshotBytes)
                )
                const snapshotMutations = await this.applySnapshot(
                    context,
                    payload.collection,
                    snapshot
                )
                appliedMutations = appliedMutations.concat(snapshotMutations)
                collectionStateChanged = true
            }

            if (payload.patches.length > 0) {
                const readyPatches = await this.resolveReadyPatches(payload, options)
                for (const readyPatch of readyPatches) {
                    const patchMutations = await this.applyPatch(
                        context,
                        payload.collection,
                        readyPatch
                    )
                    appliedMutations = appliedMutations.concat(patchMutations)
                    collectionStateChanged = true
                }
            } else {
                const outgoingContext = outgoingContexts.get(payload.collection)
                if (
                    outgoingContext &&
                    payload.state === WA_APP_STATE_COLLECTION_STATES.SUCCESS &&
                    payload.version === outgoingContext.patchVersion
                ) {
                    this.setCollectionState(
                        context,
                        payload.collection,
                        outgoingContext.patchVersion,
                        outgoingContext.nextHash,
                        outgoingContext.nextIndexValueMap
                    )
                    collectionStateChanged = true
                }
            }

            if (payload.state === WA_APP_STATE_COLLECTION_STATES.SUCCESS_HAS_MORE) {
                shouldRefetch = true
            }
            if (
                payload.state === WA_APP_STATE_COLLECTION_STATES.SUCCESS &&
                skippedUploadCollections.has(collection)
            ) {
                shouldRefetch = true
            }

            this.logger.debug('app-state collection processed', {
                collection: payload.collection,
                state: payload.state,
                version: payload.version,
                appliedMutations: appliedMutations.length
            })
            return {
                collection,
                shouldRefetch,
                stateChanged: collectionStateChanged,
                result: {
                    collection: payload.collection,
                    state: payload.state,
                    version: payload.version,
                    mutations: appliedMutations
                }
            }
        } catch (error) {
            if (error instanceof WaAppStateMissingKeyError) {
                this.logger.warn('app-state blocked by missing key', {
                    collection: payload.collection,
                    message: error.message
                })
                return {
                    collection,
                    shouldRefetch,
                    stateChanged: collectionStateChanged,
                    result: {
                        collection: payload.collection,
                        state: WA_APP_STATE_COLLECTION_STATES.BLOCKED,
                        version: payload.version
                    }
                }
            }
            throw error
        }
    }

    private async resolveReadyPatches(
        payload: CollectionResponsePayload,
        options: WaAppStateSyncOptions
    ): Promise<readonly Proto.ISyncdPatch[]> {
        const sortedPatches = payload.patches
            .map((patch) => ({
                patch,
                sortVersion: this.parseCollectionPatchVersion(payload.collection, patch)
            }))
            .sort((left, right) => left.sortVersion - right.sortVersion)
            .map((entry) => entry.patch)

        return Promise.all(
            sortedPatches.map(async (patch) => {
                let readyPatch = patch
                if (
                    (!readyPatch.mutations || readyPatch.mutations.length === 0) &&
                    readyPatch.externalMutations
                ) {
                    const downloader = options.downloadExternalBlob
                    if (!downloader) {
                        throw new Error(
                            `external patch for ${payload.collection} requires external blob downloader`
                        )
                    }
                    const patchBytes = await downloader(
                        payload.collection,
                        'patch',
                        readyPatch.externalMutations
                    )
                    const decodedMutations = proto.SyncdMutations.decode(patchBytes)
                    readyPatch = {
                        ...readyPatch,
                        mutations: decodedMutations.mutations ?? []
                    }
                }
                return this.validatePatch(payload.collection, readyPatch)
            })
        )
    }

    private toSyncRoundResult(outcomes: readonly CollectionSyncOutcome[]): SyncRoundResult {
        return {
            results: outcomes.map((entry) => entry.result),
            collectionsToRefetch: outcomes
                .filter((entry) => entry.shouldRefetch)
                .map((entry) => entry.collection),
            stateChanged: outcomes.some((entry) => entry.stateChanged)
        }
    }

    private validateSnapshot(
        collection: AppStateCollectionName,
        snapshot: Proto.ISyncdSnapshot
    ): Proto.ISyncdSnapshot {
        if (!snapshot.version?.version) {
            throw new Error(`snapshot for ${collection} is missing version`)
        }
        if (!snapshot.mac) {
            throw new Error(`snapshot for ${collection} is missing mac`)
        }
        if (!snapshot.keyId?.id) {
            throw new Error(`snapshot for ${collection} is missing keyId`)
        }
        return snapshot
    }

    private parseCollectionPatchVersion(
        collection: AppStateCollectionName,
        patch: Proto.ISyncdPatch
    ): number {
        const parsed = this.normalizeProtoLong(
            patch.version?.version,
            `patch.version.version (${collection})`
        )
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            throw new Error(`patch for ${collection} has invalid version ${parsed}`)
        }
        return parsed
    }

    private validatePatch(
        collection: AppStateCollectionName,
        patch: Proto.ISyncdPatch
    ): Proto.ISyncdPatch {
        if (!patch.version?.version) {
            throw new Error(`patch for ${collection} is missing version`)
        }
        if (!patch.snapshotMac) {
            throw new Error(`patch for ${collection} is missing snapshotMac`)
        }
        if (!patch.patchMac) {
            throw new Error(`patch for ${collection} is missing patchMac`)
        }
        if (!patch.keyId?.id) {
            throw new Error(`patch for ${collection} is missing keyId`)
        }
        if (patch.mutations && patch.mutations.length > 0 && patch.externalMutations) {
            throw new Error(`patch for ${collection} has inline and external mutations together`)
        }
        if (
            patch.exitCode?.code !== null &&
            patch.exitCode?.code !== undefined &&
            patch.exitCode.code !== 0
        ) {
            throw new Error(
                `patch for ${collection} has terminal exitCode ${patch.exitCode.code}: ${patch.exitCode.text ?? ''}`
            )
        }
        return patch
    }

    private async applySnapshot(
        context: WaAppStateSyncContext,
        collection: AppStateCollectionName,
        snapshot: Proto.ISyncdSnapshot
    ): Promise<WaAppStateMutation[]> {
        const version = this.normalizeProtoLong(
            snapshot.version?.version,
            `snapshot.version.version (${collection})`
        )
        if (!snapshot.mac) {
            throw new Error(`snapshot for ${collection} is missing mac`)
        }
        const keyId = decodeProtoBytes(snapshot.keyId?.id, `snapshot.keyId.id (${collection})`)
        const keyData = await this.getKeyData(context, keyId)
        if (!keyData) {
            throw new WaAppStateMissingKeyError(
                `missing snapshot key ${keyIdToHex(keyId)} for ${collection}`
            )
        }

        const indexValueMap = new Map<string, Uint8Array>()
        const mutations: WaAppStateMutation[] = []
        const decryptedRecords = await this.decryptSnapshotRecords(context, collection, snapshot)
        for (const { decrypted, recordKeyId } of decryptedRecords) {
            const indexMacHex = keyIdToHex(decrypted.indexMac)
            indexValueMap.set(indexMacHex, decrypted.valueMac)
            mutations.push({
                collection,
                operation: 'set',
                index: decrypted.index,
                value: decrypted.value,
                version: decrypted.version,
                indexMac: decrypted.indexMac,
                valueMac: decrypted.valueMac,
                keyId: recordKeyId,
                timestamp: this.normalizeProtoLong(
                    decrypted.value?.timestamp,
                    `snapshot.record.value.timestamp (${collection})`
                )
            })
        }

        const ltHash = await this.crypto.ltHashAdd(
            APP_STATE_EMPTY_LT_HASH,
            Array.from(indexValueMap.values())
        )
        const expectedSnapshotMac = await this.crypto.generateSnapshotMac(
            keyData,
            ltHash,
            version,
            collection
        )
        if (!uint8Equal(expectedSnapshotMac, snapshot.mac)) {
            throw new Error(`snapshot MAC mismatch for ${collection}`)
        }
        this.setCollectionState(context, collection, version, ltHash, indexValueMap)
        return mutations
    }

    private async applyPatch(
        context: WaAppStateSyncContext,
        collection: AppStateCollectionName,
        patch: Proto.ISyncdPatch
    ): Promise<WaAppStateMutation[]> {
        const patchVersion = this.normalizeProtoLong(
            patch.version?.version,
            `patch.version.version (${collection})`
        )
        const current = await this.getCollectionState(context, collection)
        if (current.version !== patchVersion - 1) {
            throw new Error(
                `patch version mismatch for ${collection}: local=${current.version}, incoming=${patchVersion}`
            )
        }

        const patchKeyId = decodeProtoBytes(patch.keyId?.id, `patch.keyId.id (${collection})`)
        const patchKeyData = await this.getKeyData(context, patchKeyId)
        if (!patchKeyData) {
            throw new WaAppStateMissingKeyError(
                `missing patch key ${keyIdToHex(patchKeyId)} for ${collection}`
            )
        }

        const decryptedMutations = await this.decryptPatchMutations(context, collection, patch)
        const nextState = await this.computeNextCollectionState(
            current.hash,
            current.indexValueMap,
            decryptedMutations.map((mutation) => ({
                operation: mutation.operationCode,
                indexMac: mutation.indexMac,
                valueMac: mutation.valueMac
            })),
            collection
        )
        await this.assertPatchMacsMatch(
            patch,
            collection,
            patchKeyData,
            patchVersion,
            nextState.hash,
            decryptedMutations
        )
        this.setCollectionState(
            context,
            collection,
            patchVersion,
            nextState.hash,
            nextState.indexValueMap
        )
        return decryptedMutations.map((mutation) => ({
            collection: mutation.collection,
            operation: mutation.operation,
            index: mutation.index,
            value: mutation.value,
            version: mutation.version,
            indexMac: mutation.indexMac,
            valueMac: mutation.valueMac,
            keyId: mutation.keyId,
            timestamp: mutation.timestamp
        }))
    }

    private async decryptSnapshotRecords(
        context: WaAppStateSyncContext,
        collection: AppStateCollectionName,
        snapshot: Proto.ISyncdSnapshot
    ): Promise<readonly DecryptedSnapshotRecord[]> {
        return Promise.all(
            (snapshot.records ?? []).map(async (record) => {
                const indexMac = decodeProtoBytes(
                    record.index?.blob,
                    `snapshot.record.index.blob (${collection})`
                )
                const valueBlob = decodeProtoBytes(
                    record.value?.blob,
                    `snapshot.record.value.blob (${collection})`
                )
                const recordKeyId = decodeProtoBytes(
                    record.keyId?.id,
                    `snapshot.record.keyId.id (${collection})`
                )
                const recordKeyData = await this.getKeyData(context, recordKeyId)
                if (!recordKeyData) {
                    throw new WaAppStateMissingKeyError(
                        `missing snapshot mutation key ${keyIdToHex(recordKeyId)} for ${collection}`
                    )
                }
                const decrypted = await this.crypto.decryptMutation({
                    operation: proto.SyncdMutation.SyncdOperation.SET,
                    keyId: recordKeyId,
                    keyData: recordKeyData,
                    indexMac,
                    valueBlob
                })
                return {
                    decrypted,
                    recordKeyId
                }
            })
        )
    }

    private async decryptPatchMutations(
        context: WaAppStateSyncContext,
        collection: AppStateCollectionName,
        patch: Proto.ISyncdPatch
    ): Promise<readonly DecryptedPatchMutation[]> {
        return Promise.all(
            (patch.mutations ?? []).map(async (mutation) => {
                const operationCode = mutation.operation
                if (operationCode === null || operationCode === undefined) {
                    throw new Error(`patch mutation is missing operation (${collection})`)
                }
                const record = mutation.record
                if (!record) {
                    throw new Error(`patch mutation is missing record (${collection})`)
                }
                const indexMac = decodeProtoBytes(
                    record.index?.blob,
                    `patch.record.index.blob (${collection})`
                )
                const valueBlob = decodeProtoBytes(
                    record.value?.blob,
                    `patch.record.value.blob (${collection})`
                )
                const recordKeyId = decodeProtoBytes(
                    record.keyId?.id,
                    `patch.record.keyId.id (${collection})`
                )
                const recordKeyData = await this.getKeyData(context, recordKeyId)
                if (!recordKeyData) {
                    throw new WaAppStateMissingKeyError(
                        `missing mutation key ${keyIdToHex(recordKeyId)} for ${collection}`
                    )
                }
                const decrypted = await this.crypto.decryptMutation({
                    operation: operationCode,
                    keyId: recordKeyId,
                    keyData: recordKeyData,
                    indexMac,
                    valueBlob
                })
                return {
                    collection,
                    operation:
                        operationCode === proto.SyncdMutation.SyncdOperation.REMOVE
                            ? 'remove'
                            : 'set',
                    operationCode,
                    index: decrypted.index,
                    value: decrypted.value,
                    version: decrypted.version,
                    indexMac: decrypted.indexMac,
                    valueMac: decrypted.valueMac,
                    keyId: recordKeyId,
                    timestamp: this.normalizeProtoLong(
                        decrypted.value?.timestamp,
                        `patch.record.value.timestamp (${collection})`
                    )
                }
            })
        )
    }

    private async assertPatchMacsMatch(
        patch: Proto.ISyncdPatch,
        collection: AppStateCollectionName,
        patchKeyData: Uint8Array,
        patchVersion: number,
        nextHash: Uint8Array,
        decryptedMutations: readonly DecryptedPatchMutation[]
    ): Promise<void> {
        const snapshotMac = decodeProtoBytes(patch.snapshotMac, `patch.snapshotMac (${collection})`)
        const expectedSnapshotMac = await this.crypto.generateSnapshotMac(
            patchKeyData,
            nextHash,
            patchVersion,
            collection
        )
        if (!uint8Equal(expectedSnapshotMac, snapshotMac)) {
            throw new Error(`patch snapshot MAC mismatch for ${collection}`)
        }

        const patchMac = decodeProtoBytes(patch.patchMac, `patch.patchMac (${collection})`)
        const expectedPatchMac = await this.crypto.generatePatchMac(
            patchKeyData,
            snapshotMac,
            decryptedMutations.map((mutation) => mutation.valueMac),
            patchVersion,
            collection
        )
        if (!uint8Equal(expectedPatchMac, patchMac)) {
            throw new Error(`patch MAC mismatch for ${collection}`)
        }
    }

    private async buildOutgoingPatch(
        context: WaAppStateSyncContext,
        collection: AppStateCollectionName,
        snapshot: WaAppStateCollectionStoreState,
        pendingMutations: readonly WaAppStateMutationInput[]
    ): Promise<{ readonly encodedPatch: Uint8Array; readonly context: OutgoingPatchContext }> {
        const activeKey = await this.store.getActiveSyncKey()
        if (!activeKey) {
            throw new WaAppStateMissingKeyError(`no sync key available to upload ${collection}`)
        }

        const encryptedResults = await Promise.all(
            pendingMutations.map(async (mutation) => {
                const value = mutation.operation === 'set' ? mutation.value : mutation.previousValue
                const operationCode =
                    mutation.operation === 'remove'
                        ? proto.SyncdMutation.SyncdOperation.REMOVE
                        : proto.SyncdMutation.SyncdOperation.SET
                const encrypted = await this.crypto.encryptMutation({
                    operation: operationCode,
                    keyId: activeKey.keyId,
                    keyData: activeKey.keyData,
                    index: mutation.index,
                    value,
                    version: mutation.version
                })
                return { operationCode, encrypted }
            })
        )

        const encryptedMutations: Proto.ISyncdMutation[] = encryptedResults.map(
            ({ operationCode, encrypted }) => ({
                operation: operationCode,
                record: {
                    keyId: { id: activeKey.keyId },
                    index: { blob: encrypted.indexMac },
                    value: { blob: encrypted.valueBlob }
                }
            })
        )
        const macMutations: MacMutation[] = encryptedResults.map(
            ({ operationCode, encrypted }) => ({
                operation: operationCode,
                indexMac: encrypted.indexMac,
                valueMac: encrypted.valueMac
            })
        )

        const nextState = await this.computeNextCollectionState(
            snapshot.hash,
            snapshot.indexValueMap,
            macMutations,
            collection
        )
        const patchVersion = snapshot.version + 1
        const snapshotMac = await this.crypto.generateSnapshotMac(
            activeKey.keyData,
            nextState.hash,
            patchVersion,
            collection
        )
        const patchMac = await this.crypto.generatePatchMac(
            activeKey.keyData,
            snapshotMac,
            macMutations.map((item) => item.valueMac),
            patchVersion,
            collection
        )

        const encodedPatch = proto.SyncdPatch.encode({
            version: { version: patchVersion },
            mutations: encryptedMutations,
            snapshotMac,
            patchMac,
            keyId: { id: activeKey.keyId }
        }).finish()

        return {
            encodedPatch,
            context: {
                collection,
                patchVersion,
                nextHash: nextState.hash,
                nextIndexValueMap: nextState.indexValueMap
            }
        }
    }

    private async computeNextCollectionState(
        baseHash: Uint8Array,
        baseMap: ReadonlyMap<string, Uint8Array>,
        mutations: readonly MacMutation[],
        collection: AppStateCollectionName
    ): Promise<{ readonly hash: Uint8Array; readonly indexValueMap: Map<string, Uint8Array> }> {
        const indexValueMap = new Map<string, Uint8Array>()
        for (const [indexMacHex, valueMac] of baseMap.entries()) {
            indexValueMap.set(indexMacHex, valueMac)
        }

        const addValues: Uint8Array[] = []
        const removeValues: Uint8Array[] = []
        for (const mutation of mutations) {
            const indexMacHex = keyIdToHex(mutation.indexMac)
            const existing = indexValueMap.get(indexMacHex)
            if (mutation.operation === proto.SyncdMutation.SyncdOperation.REMOVE) {
                if (!existing) {
                    throw new Error(
                        `cannot remove missing index MAC ${indexMacHex} in ${collection}`
                    )
                }
                indexValueMap.delete(indexMacHex)
                removeValues.push(existing)
                continue
            }

            if (existing) {
                removeValues.push(existing)
            }
            indexValueMap.set(indexMacHex, mutation.valueMac)
            addValues.push(mutation.valueMac)
        }

        const nextHash = await this.crypto.ltHashSubtractThenAdd(baseHash, addValues, removeValues)
        return {
            hash: nextHash.hash,
            indexValueMap
        }
    }

    private normalizeProtoLong(value: unknown, field: string): number {
        if (value === null || value === undefined) {
            return 0
        }
        if (typeof value !== 'number' && !isProtoLongLike(value)) {
            throw new Error(`invalid ${field}: expected protobuf Long or number`)
        }
        try {
            return longToNumber(value)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`invalid ${field}: ${reason}`)
        }
    }

    private groupPendingMutations(
        pendingMutations: readonly WaAppStateMutationInput[]
    ): Map<AppStateCollectionName, readonly WaAppStateMutationInput[]> {
        const grouped = new Map<AppStateCollectionName, WaAppStateMutationInput[]>()
        for (const mutation of pendingMutations) {
            const list = grouped.get(mutation.collection)
            if (list) {
                list.push(mutation)
            } else {
                grouped.set(mutation.collection, [mutation])
            }
        }

        const compacted = new Map<AppStateCollectionName, readonly WaAppStateMutationInput[]>()
        for (const [collection, list] of grouped.entries()) {
            const seenIndexes = new Set<string>()
            const reversed: WaAppStateMutationInput[] = []
            for (let index = list.length - 1; index >= 0; index -= 1) {
                const mutation = list[index]
                if (seenIndexes.has(mutation.index)) {
                    continue
                }
                seenIndexes.add(mutation.index)
                reversed.push(mutation)
            }
            compacted.set(collection, reversed.reverse())
        }
        return compacted
    }

    private async getKeyData(
        context: WaAppStateSyncContext,
        keyId: Uint8Array
    ): Promise<Uint8Array | null> {
        const keyHex = keyIdToHex(keyId)
        if (context.keys.has(keyHex)) {
            return context.keys.get(keyHex) ?? null
        }
        const value = await this.store.getSyncKeyData(keyId)
        context.keys.set(keyHex, value)
        return value
    }

    private async getCollectionState(
        context: WaAppStateSyncContext,
        collection: AppStateCollectionName
    ): Promise<WaAppStateCollectionStoreState> {
        const cached = context.collections.get(collection)
        if (cached) {
            return cached
        }
        const state = await this.store.getCollectionState(collection)
        context.collections.set(collection, state)
        return state
    }

    private setCollectionState(
        context: WaAppStateSyncContext,
        collection: AppStateCollectionName,
        version: number,
        hash: Uint8Array,
        indexValueMap: ReadonlyMap<string, Uint8Array>
    ): void {
        context.collections.set(collection, {
            version,
            hash,
            indexValueMap
        })
        context.dirtyCollections.add(collection)
    }

    private async persistCollectionUpdates(context: WaAppStateSyncContext): Promise<void> {
        const updates = Array.from(context.dirtyCollections.values())
            .map((collection) => {
                const state = context.collections.get(collection)
                if (!state) {
                    return null
                }
                return {
                    collection,
                    version: state.version,
                    hash: state.hash,
                    indexValueMap: state.indexValueMap
                }
            })
            .filter((entry): entry is WaAppStateCollectionStateUpdate => entry !== null)
        if (updates.length === 0) {
            return
        }
        if (typeof this.store.setCollectionStates === 'function') {
            await this.store.setCollectionStates(updates)
            return
        }
        await Promise.all(
            updates.map((update) =>
                this.store.setCollectionState(
                    update.collection,
                    update.version,
                    update.hash,
                    update.indexValueMap
                )
            )
        )
    }
}
