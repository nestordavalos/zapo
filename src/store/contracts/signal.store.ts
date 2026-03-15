import type {
    PreKeyRecord,
    RegistrationInfo,
    SignalAddress,
    SignalSessionRecord,
    SignedPreKeyRecord
} from '@signal/types'

export interface WaSignalStore {
    getRegistrationInfo(): Promise<RegistrationInfo | null>
    setRegistrationInfo(info: RegistrationInfo): Promise<void>
    getSignedPreKey(): Promise<SignedPreKeyRecord | null>
    setSignedPreKey(record: SignedPreKeyRecord): Promise<void>
    getSignedPreKeyById(keyId: number): Promise<SignedPreKeyRecord | null>
    setSignedPreKeyRotationTs(value: number | null): Promise<void>
    getSignedPreKeyRotationTs(): Promise<number | null>
    putPreKey(record: PreKeyRecord): Promise<void>
    getOrGenPreKeys(
        count: number,
        generator: (keyId: number) => PreKeyRecord | Promise<PreKeyRecord>
    ): Promise<readonly PreKeyRecord[]>
    getPreKeyById(keyId: number): Promise<PreKeyRecord | null>
    getPreKeysById(keyIds: readonly number[]): Promise<readonly (PreKeyRecord | null)[]>
    consumePreKeyById(keyId: number): Promise<PreKeyRecord | null>
    getOrGenSinglePreKey(
        generator: (keyId: number) => PreKeyRecord | Promise<PreKeyRecord>
    ): Promise<PreKeyRecord>
    markKeyAsUploaded(keyId: number): Promise<void>
    setServerHasPreKeys(value: boolean): Promise<void>
    getServerHasPreKeys(): Promise<boolean>
    hasSession(address: SignalAddress): Promise<boolean>
    hasSessions(addresses: readonly SignalAddress[]): Promise<readonly boolean[]>
    getSession(address: SignalAddress): Promise<SignalSessionRecord | null>
    setSession(address: SignalAddress, session: SignalSessionRecord): Promise<void>
    deleteSession(address: SignalAddress): Promise<void>
    getRemoteIdentity(address: SignalAddress): Promise<Uint8Array | null>
    setRemoteIdentity(address: SignalAddress, identityKey: Uint8Array): Promise<void>
    setRemoteIdentities(
        entries: readonly {
            readonly address: SignalAddress
            readonly identityKey: Uint8Array
        }[]
    ): Promise<void>
}
