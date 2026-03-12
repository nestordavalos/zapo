import { WaAppStateMemoryStore } from '@store/providers/memory/appstate.store'
import { WaRetryMemoryStore } from '@store/providers/memory/retry.store'
import { SenderKeyStore as SenderKeyMemoryStore } from '@store/providers/memory/sender-key.store'
import { WaSignalStore as WaSignalMemoryStore } from '@store/providers/memory/signal.store'
import { WaAppStateSqliteStore } from '@store/providers/sqlite/appstate.store'
import { WaAuthSqliteStore } from '@store/providers/sqlite/auth.store'
import { WaRetrySqliteStore } from '@store/providers/sqlite/retry.store'
import { SenderKeyStore as SenderKeySqliteStore } from '@store/providers/sqlite/sender-key.store'
import { WaSignalStore as WaSignalSqliteStore } from '@store/providers/sqlite/signal.store'
import type {
    WaCreateStoreCustomProviders,
    WaCreateStoreOptions,
    WaStore,
    WaStoreDomainValueOrFactory,
    WaStoreProviderSelection,
    WaStoreSession
} from '@store/types'

const DEFAULT_PROVIDERS: Required<WaStoreProviderSelection> = {
    auth: 'sqlite',
    signal: 'sqlite',
    senderKey: 'sqlite',
    appState: 'sqlite',
    retry: 'sqlite'
}

function resolveCustomStore<T>(
    sessionId: string,
    custom: WaStoreDomainValueOrFactory<T> | undefined,
    domain: keyof WaCreateStoreCustomProviders
): T | null {
    if (!custom) {
        return null
    }
    const resolved =
        typeof custom === 'function' ? (custom as (id: string) => T)(sessionId) : custom
    if (!resolved) {
        throw new Error(`custom.${domain} must resolve to a store instance`)
    }
    return resolved
}

export function createStore(options: WaCreateStoreOptions): WaStore {
    const providers: Required<WaStoreProviderSelection> = {
        ...DEFAULT_PROVIDERS,
        ...(options.providers ?? {})
    }
    const sessions = new Map<string, WaStoreSession>()

    return {
        session(sessionId: string): WaStoreSession {
            const normalizedSessionId = sessionId.trim()
            if (normalizedSessionId.length === 0) {
                throw new Error('sessionId must be a non-empty string')
            }

            const cached = sessions.get(normalizedSessionId)
            if (cached) {
                return cached
            }

            const custom = options.custom
            const customAuth = resolveCustomStore(normalizedSessionId, custom?.auth, 'auth')
            const customSignal = resolveCustomStore(normalizedSessionId, custom?.signal, 'signal')
            const customSenderKey = resolveCustomStore(
                normalizedSessionId,
                custom?.senderKey,
                'senderKey'
            )
            const customAppState = resolveCustomStore(
                normalizedSessionId,
                custom?.appState,
                'appState'
            )
            const customRetry = resolveCustomStore(normalizedSessionId, custom?.retry, 'retry')

            const requiresSqlite =
                !customAuth ||
                (!customSignal && providers.signal === 'sqlite') ||
                (!customSenderKey && providers.senderKey === 'sqlite') ||
                (!customAppState && providers.appState === 'sqlite') ||
                (!customRetry && providers.retry === 'sqlite')

            const sqlite = options.sqlite
            if (requiresSqlite && (!sqlite?.path || sqlite.path.trim().length === 0)) {
                throw new Error('sqlite.path must be configured for unresolved sqlite domains.')
            }

            const sqliteOptions =
                sqlite && sqlite.path.trim().length > 0
                    ? ({
                          path: sqlite.path,
                          sessionId: normalizedSessionId,
                          driver: sqlite.driver ?? 'auto',
                          pragmas: sqlite.pragmas
                      } as const)
                    : null

            const session: WaStoreSession = {
                auth: customAuth ?? new WaAuthSqliteStore(sqliteOptions!),
                signal:
                    customSignal ??
                    (providers.signal === 'memory'
                        ? new WaSignalMemoryStore()
                        : new WaSignalSqliteStore(sqliteOptions!)),
                senderKey:
                    customSenderKey ??
                    (providers.senderKey === 'memory'
                        ? new SenderKeyMemoryStore()
                        : new SenderKeySqliteStore(sqliteOptions!)),
                appState:
                    customAppState ??
                    (providers.appState === 'memory'
                        ? new WaAppStateMemoryStore()
                        : new WaAppStateSqliteStore(sqliteOptions!)),
                retry:
                    customRetry ??
                    (providers.retry === 'memory'
                        ? new WaRetryMemoryStore()
                        : new WaRetrySqliteStore(sqliteOptions!))
            }

            sessions.set(normalizedSessionId, session)
            return session
        }
    }
}
