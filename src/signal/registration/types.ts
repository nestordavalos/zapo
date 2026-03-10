import type { PreKeyRecord, RegistrationInfo, SignedPreKeyRecord } from '../../auth/types'
import type { WaSignalStore } from '../store/WaSignalStore'

export interface RegistrationBundle {
    readonly registrationInfo: RegistrationInfo
    readonly signedPreKey: SignedPreKeyRecord
    readonly firstPreKey: PreKeyRecord
}

export interface RegistrationSignalKeyApi {
    readonly generateRegistrationInfo: () => Promise<RegistrationInfo>
    readonly generatePreKeyPair: (keyId: number) => Promise<PreKeyRecord>
    readonly generateSignedPreKey: (
        keyId: number,
        signingPrivateKey: Uint8Array
    ) => Promise<SignedPreKeyRecord>
}

export type CreateAndStoreInitialKeys = (store: WaSignalStore) => Promise<RegistrationBundle>
