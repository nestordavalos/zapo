import type { SignalKeyPair } from '../../crypto/curves/types'
import type { Logger } from '../../infra/log/types'
import type { WaAdvSignature } from '../../signal/crypto/WaAdvSignature'
import type { BinaryNode } from '../../transport/types'
import type { WaAuthCredentials, WaPairingCodeSession } from '../types'

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

export interface ActivePairingSession extends WaPairingCodeSession {
    readonly companionEphemeralKeyPair: SignalKeyPair
    readonly phoneJid: string
    readonly pairingCode: string
    attempts: number
    finished: boolean
}

export interface WaPairingSuccessHandlerOptions {
    readonly logger: Logger
    readonly advSignature: WaAdvSignature
    readonly getCredentials: () => WaAuthCredentials | null
    readonly updateCredentials: (credentials: WaAuthCredentials) => Promise<void>
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly clearQr: () => void
    readonly emitPaired: (credentials: WaAuthCredentials) => void
}
