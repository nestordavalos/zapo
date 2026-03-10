import type { SignalKeyPair, WaAuthCredentials, WaPairingCodeSession } from '../../auth/types'
import type { Logger } from '../../infra/log/types'
import type { WaAdvSignature } from '../../signal/crypto/WaAdvSignature'
import type { BinaryNode } from '../../transport/types'

export interface WaAuthSocketOptions {
    readonly url?: string
    readonly urls?: readonly string[]
    readonly protocols?: readonly string[]
    readonly connectTimeoutMs?: number
    readonly reconnectIntervalMs?: number
    readonly timeoutIntervalMs?: number
    readonly maxReconnectAttempts?: number
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
