import type { SignalSerializedKeyPair, SignalSessionRecord } from '../../signal/types'

export interface DecryptOutcome {
    readonly updatedSession: SignalSessionRecord
    readonly plaintext: Uint8Array
    readonly newSessionInfo: {
        readonly newIdentity: Uint8Array | null
        readonly baseSession: SignalSessionRecord
        readonly usedPreKey: number | null
    } | null
}

export interface LocalIdentityContext {
    readonly regId: number
    readonly staticKeyPair: SignalSerializedKeyPair
}

export interface IncomingRatchetKeys {
    readonly signed: SignalSerializedKeyPair
    readonly oneTime?: SignalSerializedKeyPair
    readonly ratchet: SignalSerializedKeyPair
}
