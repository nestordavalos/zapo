import type { WaSignalStore } from '../store/WaSignalStore'

import type { RegistrationBundle, RegistrationSignalKeyApi } from './types'

export async function createAndStoreInitialKeys(
    store: WaSignalStore,
    signalKeyApi: RegistrationSignalKeyApi
): Promise<RegistrationBundle> {
    const registrationInfo = await signalKeyApi.generateRegistrationInfo()
    const signedPreKey = await signalKeyApi.generateSignedPreKey(
        1,
        registrationInfo.identityKeyPair.privKey
    )
    const firstPreKey = await signalKeyApi.generatePreKeyPair(1)

    await store.setRegistrationInfo(registrationInfo)
    await store.setSignedPreKey(signedPreKey)
    await store.getOrGenSinglePreKey(async () => firstPreKey)

    return {
        registrationInfo,
        signedPreKey,
        firstPreKey
    }
}
