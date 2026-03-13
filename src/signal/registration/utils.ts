import {
    generatePreKeyPair,
    generateRegistrationInfo,
    generateSignedPreKey
} from '@signal/registration/keygen'
import type { PreKeyRecord, RegistrationInfo, SignedPreKeyRecord } from '@signal/types'
import type { WaSignalStore } from '@store/contracts/signal.store'

interface RegistrationBundle {
    readonly registrationInfo: RegistrationInfo
    readonly signedPreKey: SignedPreKeyRecord
    readonly firstPreKey: PreKeyRecord
}

export async function createAndStoreInitialKeys(store: WaSignalStore): Promise<RegistrationBundle> {
    const registrationInfo = await generateRegistrationInfo()
    const signedPreKey = await generateSignedPreKey(1, registrationInfo.identityKeyPair.privKey)
    const firstPreKey = await generatePreKeyPair(1)

    await store.setRegistrationInfo(registrationInfo)
    await store.setSignedPreKey(signedPreKey)
    await store.getOrGenSinglePreKey(async () => firstPreKey)

    return {
        registrationInfo,
        signedPreKey,
        firstPreKey
    }
}
