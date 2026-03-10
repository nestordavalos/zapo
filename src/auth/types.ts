import type { WaAppStateStoreData } from '../appstate/types'
import type { X25519 } from '../crypto/curves/X25519'
import type { Logger } from '../infra/log/types'
import type { Proto } from '../proto'
import type { WaAdvSignature } from '../signal/crypto/WaAdvSignature'
import type { WaSignalStore } from '../signal/store/WaSignalStore'
import type { BinaryNode } from '../transport/types'

import type { WaPairingCodeCrypto } from './pairing/WaPairingCodeCrypto'

export type AdvDeviceIdentity = Proto.IADVDeviceIdentity
export type AdvSignedDeviceIdentity = Proto.IADVSignedDeviceIdentity
export type AdvKeyIndexList = Proto.IADVKeyIndexList
export type ClientPayload = Proto.IClientPayload
export type HandshakeMessage = Proto.IHandshakeMessage

export interface SignalKeyPair {
    readonly pubKey: Uint8Array
    readonly privKey: Uint8Array
}

export interface RegistrationInfo {
    readonly registrationId: number
    readonly identityKeyPair: SignalKeyPair
}

export interface PreKeyRecord {
    readonly keyId: number
    readonly keyPair: SignalKeyPair
    readonly uploaded?: boolean
}

export interface SignedPreKeyRecord {
    readonly keyId: number
    readonly keyPair: SignalKeyPair
    readonly signature: Uint8Array
    readonly uploaded?: boolean
}

export interface AuthState {
    readonly noiseKeyPair: SignalKeyPair
    readonly registrationInfo?: RegistrationInfo
    readonly signedPreKey?: SignedPreKeyRecord
    readonly signedIdentity?: AdvSignedDeviceIdentity
    readonly clientPayload?: ClientPayload
    readonly advSecretKey?: Uint8Array
}

export interface WaAuthCredentials {
    readonly noiseKeyPair: SignalKeyPair
    readonly registrationInfo: RegistrationInfo
    readonly signedPreKey: SignedPreKeyRecord
    readonly advSecretKey: Uint8Array
    readonly signedIdentity?: AdvSignedDeviceIdentity
    readonly meJid?: string
    readonly meLid?: string
    readonly meDisplayName?: string
    readonly companionEncStatic?: Uint8Array
    readonly platform?: string
    readonly serverStaticKey?: Uint8Array
    readonly serverHasPreKeys?: boolean
    readonly routingInfo?: Uint8Array
    readonly lastSuccessTs?: number
    readonly propsVersion?: number
    readonly abPropsVersion?: number
    readonly connectionLocation?: string
    readonly accountCreationTs?: number
    readonly appState?: WaAppStateStoreData
}

export interface WaPairingCodeSession {
    readonly code: string
    readonly phoneJid: string
    readonly ref?: Uint8Array
    readonly createdAtSeconds: number
}

export interface WaAuthState {
    readonly connected: boolean
    readonly registered: boolean
    readonly hasQr: boolean
    readonly hasPairingCode: boolean
}

export interface WaAuthClientOptions {
    readonly authPath: string
    readonly devicePlatform?: string
}

export interface WaAuthClientCallbacks {
    readonly onQr?: (qr: string, ttlMs: number) => void
    readonly onPairingCode?: (code: string) => void
    readonly onPairingRefresh?: (forceManual: boolean) => void
    readonly onPaired?: (credentials: WaAuthCredentials) => void
    readonly onError?: (error: Error) => void
}

export interface WaAuthClientDependencies {
    readonly logger: Logger
    readonly signalStore: WaSignalStore
    readonly x25519: X25519
    readonly pairingCrypto: WaPairingCodeCrypto
    readonly advSignature: WaAdvSignature
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
    readonly callbacks?: WaAuthClientCallbacks
}

export interface WaSuccessPersistAttributes {
    readonly meLid?: string
    readonly meDisplayName?: string
    readonly companionEncStatic?: Uint8Array
    readonly lastSuccessTs?: number
    readonly propsVersion?: number
    readonly abPropsVersion?: number
    readonly connectionLocation?: string
    readonly accountCreationTs?: number
}
