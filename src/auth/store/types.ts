import type { AppStateCollectionName, WaAppStateStoreData } from '../../appstate/types'
import type { Proto } from '../../proto'

export interface SerializedSignalKeyPair {
    readonly pubKey: string
    readonly privKey: string
}

export interface SerializedRegistrationInfo {
    readonly registrationId: number
    readonly identityKeyPair: SerializedSignalKeyPair
}

export interface SerializedSignedPreKeyRecord {
    readonly keyId: number
    readonly keyPair: SerializedSignalKeyPair
    readonly signature: string
}

export interface SerializedAuthCredentials {
    readonly noiseKeyPair: SerializedSignalKeyPair
    readonly registrationInfo: SerializedRegistrationInfo
    readonly signedPreKey: SerializedSignedPreKeyRecord
    readonly advSecretKey: string
    readonly signedIdentity?: string
    readonly meJid?: string
    readonly meLid?: string
    readonly meDisplayName?: string
    readonly companionEncStatic?: string
    readonly platform?: string
    readonly serverStaticKey?: string
    readonly serverHasPreKeys?: boolean
    readonly routingInfo?: string
    readonly lastSuccessTs?: number
    readonly propsVersion?: number
    readonly abPropsVersion?: number
    readonly connectionLocation?: string
    readonly accountCreationTs?: number
    readonly appState?: SerializedAppStateStoreData
}

export interface SerializedAppStateSyncKey {
    readonly keyId: string
    readonly keyData: string
    readonly timestamp: number
    readonly fingerprint?: Proto.Message.IAppStateSyncKeyFingerprint
}

export interface SerializedAppStateCollection {
    readonly version: number
    readonly hash: string
    readonly indexValueMap: Readonly<Record<string, string>>
}

export interface SerializedAppStateStoreData {
    readonly keys: readonly SerializedAppStateSyncKey[]
    readonly collections: Partial<Record<AppStateCollectionName, SerializedAppStateCollection>>
}

export type AppStateCollectionEntry = readonly [
    AppStateCollectionName,
    WaAppStateStoreData['collections'][AppStateCollectionName]
]
