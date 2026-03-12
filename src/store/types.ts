import type { WaAppStateStore } from '@store/contracts/appstate.store'
import type { WaAuthStore } from '@store/contracts/auth.store'
import type { WaRetryStore } from '@store/contracts/retry.store'
import type { WaSenderKeyStore } from '@store/contracts/sender-key.store'
import type { WaSignalStore } from '@store/contracts/signal.store'

export type WaSqliteDriver = 'auto' | 'better-sqlite3' | 'bun'

export interface WaSqliteStorageOptions {
    readonly path: string
    readonly sessionId: string
    readonly driver?: WaSqliteDriver
    readonly pragmas?: Readonly<Record<string, string | number>>
}

export interface WaStoreCodec<T> {
    serialize(value: T): Uint8Array
    deserialize(raw: Uint8Array): T
}

export type WaStoreCodecRegistry = Readonly<Record<string, WaStoreCodec<unknown>>>

export interface WaStorageOptions {
    readonly sqlite?: WaSqliteStorageOptions
    readonly codecs?: Partial<WaStoreCodecRegistry>
}

export interface WaStoreSession {
    readonly auth: WaAuthStore
    readonly signal: WaSignalStore
    readonly senderKey: WaSenderKeyStore
    readonly appState: WaAppStateStore
    readonly retry: WaRetryStore
}

export interface WaStore {
    session(sessionId: string): WaStoreSession
}

export interface WaStoreProviderSelection {
    readonly auth?: 'sqlite'
    readonly signal?: 'sqlite' | 'memory'
    readonly senderKey?: 'sqlite' | 'memory'
    readonly appState?: 'sqlite' | 'memory'
    readonly retry?: 'sqlite' | 'memory'
}

export type WaStoreDomainValueOrFactory<T> = T | ((sessionId: string) => T)

export interface WaCreateStoreCustomProviders {
    readonly auth?: WaStoreDomainValueOrFactory<WaAuthStore>
    readonly signal?: WaStoreDomainValueOrFactory<WaSignalStore>
    readonly senderKey?: WaStoreDomainValueOrFactory<WaSenderKeyStore>
    readonly appState?: WaStoreDomainValueOrFactory<WaAppStateStore>
    readonly retry?: WaStoreDomainValueOrFactory<WaRetryStore>
}

export interface WaCreateStoreOptions {
    readonly sqlite?: Omit<WaSqliteStorageOptions, 'sessionId'>
    readonly providers?: WaStoreProviderSelection
    readonly custom?: WaCreateStoreCustomProviders
}
