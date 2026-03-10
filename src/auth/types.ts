import type { WaAppStateStoreData } from '../appstate/types'
import type { SignalKeyPair } from '../crypto/curves/types'
import type { Proto } from '../proto'
import type { RegistrationInfo, SignedPreKeyRecord } from '../signal/types'

export type AdvDeviceIdentity = Proto.IADVDeviceIdentity
export type AdvSignedDeviceIdentity = Proto.IADVSignedDeviceIdentity
export type AdvKeyIndexList = Proto.IADVKeyIndexList
export type ClientPayload = Proto.IClientPayload
export type HandshakeMessage = Proto.IHandshakeMessage

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
