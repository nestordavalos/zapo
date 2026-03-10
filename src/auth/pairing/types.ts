import type { SignalKeyPair } from '../../auth/types'

export interface WaCompanionHelloState {
    readonly pairingCode: string
    readonly companionEphemeralKeyPair: SignalKeyPair
    readonly wrappedCompanionEphemeralPub: Uint8Array
}

export interface WaCompanionFinishResult {
    readonly wrappedKeyBundle: Uint8Array
    readonly companionIdentityPublic: Uint8Array
    readonly advSecret: Uint8Array
}
