import type { WaSqliteDriver, WaSqliteStorageOptions } from '@store/types'
import { toSafeNumber } from '@util/primitives'
import { isBunRuntime } from '@util/runtime'

type SqliteStatementLike = {
    readonly run: (...args: unknown[]) => unknown
    readonly get: (...args: unknown[]) => unknown
    readonly all: (...args: unknown[]) => unknown
}

type SqliteDatabaseLike = {
    readonly exec: (sql: string) => unknown
    readonly close: () => unknown
    readonly pragma?: (pragma: string) => unknown
    readonly prepare?: (sql: string) => SqliteStatementLike
    readonly query?: (sql: string) => SqliteStatementLike
}

export interface WaSqliteConnection {
    readonly driver: Exclude<WaSqliteDriver, 'auto'>
    exec(sql: string): void
    run(sql: string, params?: readonly unknown[]): void
    get<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | null
    all<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): readonly T[]
    close(): void
}

const BETTER_SQLITE3_MODULE = 'better-sqlite3'
const BUN_SQLITE_MODULE = 'bun:sqlite'
const SQLITE_PRAGMA_TOKEN_PATTERN = /^[A-Za-z0-9_+-]+$/
const DEFAULT_SQLITE_PRAGMAS: Readonly<Record<string, string | number>> = Object.freeze({
    journal_mode: 'WAL',
    synchronous: 'normal',
    busy_timeout: 5000
})

const ALLOWED_SQLITE_PRAGMAS: Readonly<Record<string, 'int' | 'token' | 'token_or_int'>> = {
    auto_vacuum: 'token_or_int',
    busy_timeout: 'int',
    cache_size: 'int',
    foreign_keys: 'token_or_int',
    journal_mode: 'token',
    journal_size_limit: 'int',
    legacy_alter_table: 'token_or_int',
    locking_mode: 'token',
    mmap_size: 'int',
    page_size: 'int',
    recursive_triggers: 'token_or_int',
    secure_delete: 'token_or_int',
    synchronous: 'token_or_int',
    temp_store: 'token_or_int',
    wal_autocheckpoint: 'int'
}

function asConstructor(loaded: unknown): new (path: string) => SqliteDatabaseLike {
    if (typeof loaded === 'function') {
        return loaded as new (path: string) => SqliteDatabaseLike
    }
    if (loaded && typeof loaded === 'object') {
        const candidate = (loaded as { default?: unknown }).default
        if (typeof candidate === 'function') {
            return candidate as new (path: string) => SqliteDatabaseLike
        }
    }
    throw new Error('invalid sqlite driver export')
}

function statementFor(db: SqliteDatabaseLike, sql: string): SqliteStatementLike {
    const prepare = db.prepare ?? db.query
    if (!prepare) {
        throw new Error('sqlite driver does not expose prepare/query method')
    }
    const statement = prepare.call(db, sql)
    if (
        !statement ||
        typeof statement.run !== 'function' ||
        typeof statement.get !== 'function' ||
        typeof statement.all !== 'function'
    ) {
        throw new Error('invalid sqlite statement API')
    }
    return statement
}

function wrapConnection(
    db: SqliteDatabaseLike,
    driver: Exclude<WaSqliteDriver, 'auto'>,
    onClose?: () => void
): WaSqliteConnection {
    const statementCache = new Map<string, SqliteStatementLike>()
    const cachedStatementFor = (sql: string): SqliteStatementLike => {
        const cached = statementCache.get(sql)
        if (cached) {
            return cached
        }
        const statement = statementFor(db, sql)
        statementCache.set(sql, statement)
        return statement
    }

    return {
        driver,
        exec(sql) {
            db.exec(sql)
        },
        run(sql, params) {
            const statement = cachedStatementFor(sql)
            if (!params || params.length === 0) {
                statement.run()
                return
            }
            statement.run(...params)
        },
        get<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | null {
            const statement = cachedStatementFor(sql)
            const row = !params || params.length === 0 ? statement.get() : statement.get(...params)
            return (row as T | undefined) ?? null
        },
        all<T extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[]
        ): readonly T[] {
            const statement = cachedStatementFor(sql)
            const rows = !params || params.length === 0 ? statement.all() : statement.all(...params)
            return Array.isArray(rows) ? (rows as readonly T[]) : []
        },
        close() {
            statementCache.clear()
            try {
                db.close()
            } finally {
                onClose?.()
            }
        }
    }
}

function pragmaEntries(options: WaSqliteStorageOptions): readonly [string, string | number][] {
    return Object.entries(mergePragmas(options.pragmas))
}

function mergePragmas(
    pragmas: WaSqliteStorageOptions['pragmas']
): Readonly<Record<string, string | number>> {
    return {
        ...DEFAULT_SQLITE_PRAGMAS,
        ...(pragmas ?? {})
    }
}

const ALLOWED_SQLITE_PRAGMA_LIST = Object.keys(ALLOWED_SQLITE_PRAGMAS).sort().join(', ')

function normalizePragmaKey(rawKey: string): string {
    const key = rawKey.trim().toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_SQLITE_PRAGMAS, key)) {
        throw new Error(
            `unsupported sqlite pragma "${rawKey}". Allowed pragmas: ${ALLOWED_SQLITE_PRAGMA_LIST}`
        )
    }
    return key
}

function normalizePragmaToken(key: string, rawValue: string): string {
    const value = rawValue.trim()
    if (value.length === 0 || !SQLITE_PRAGMA_TOKEN_PATTERN.test(value)) {
        throw new Error(
            `invalid sqlite pragma "${key}" value "${rawValue}". Allowed token pattern: ${SQLITE_PRAGMA_TOKEN_PATTERN}`
        )
    }
    return value
}

function normalizePragmaValue(key: string, rawValue: string | number): string {
    const kind = ALLOWED_SQLITE_PRAGMAS[key]
    if (kind === 'int') {
        if (typeof rawValue !== 'number') {
            throw new Error(`sqlite pragma "${key}" must be a number`)
        }
        return String(toSafeNumber(rawValue, `sqlite pragma "${key}"`))
    }

    if (kind === 'token') {
        if (typeof rawValue !== 'string') {
            throw new Error(`sqlite pragma "${key}" must be a string token`)
        }
        return normalizePragmaToken(key, rawValue)
    }

    if (typeof rawValue === 'number') {
        return String(toSafeNumber(rawValue, `sqlite pragma "${key}"`))
    }

    return normalizePragmaToken(key, rawValue)
}

function applyPragmas(db: SqliteDatabaseLike, options: WaSqliteStorageOptions): void {
    for (const [rawKey, rawValue] of pragmaEntries(options)) {
        const key = normalizePragmaKey(rawKey)
        const value = normalizePragmaValue(key, rawValue)
        const statement = `${key}=${value}`
        if (db.pragma) {
            db.pragma(statement)
            continue
        }
        db.exec(`PRAGMA ${statement}`)
    }
}

function closeDatabaseSafely(db: SqliteDatabaseLike): void {
    try {
        db.close()
    } catch {
        return
    }
}

async function openBetterSqlite(
    options: WaSqliteStorageOptions,
    onClose: () => void
): Promise<WaSqliteConnection> {
    let loaded: unknown
    try {
        loaded = await import(BETTER_SQLITE3_MODULE)
    } catch {
        throw new Error(
            'optional dependency "better-sqlite3" is not installed. Install with: npm i better-sqlite3'
        )
    }

    const Database = asConstructor(loaded)
    const db = new Database(options.path)
    try {
        applyPragmas(db, options)
    } catch (error) {
        closeDatabaseSafely(db)
        throw error
    }

    return wrapConnection(db, 'better-sqlite3', onClose)
}

async function openBunSqlite(
    options: WaSqliteStorageOptions,
    onClose: () => void
): Promise<WaSqliteConnection> {
    let loaded: unknown
    try {
        loaded = await import(BUN_SQLITE_MODULE)
    } catch {
        throw new Error(
            'bun runtime sqlite module "bun:sqlite" is unavailable. Run this in Bun or set storage.sqlite.driver to "better-sqlite3".'
        )
    }

    if (!loaded || typeof loaded !== 'object') {
        throw new Error('invalid bun sqlite module export')
    }
    const ctor = (loaded as { Database?: unknown }).Database
    if (typeof ctor !== 'function') {
        throw new Error('invalid bun sqlite module export')
    }

    const db = new (ctor as new (path: string) => SqliteDatabaseLike)(options.path)
    try {
        applyPragmas(db, options)
    } catch (error) {
        closeDatabaseSafely(db)
        throw error
    }

    return wrapConnection(db, 'bun', onClose)
}

function resolveDriver(requested: WaSqliteDriver | undefined): WaSqliteDriver {
    if (requested && requested !== 'auto') {
        return requested
    }
    return isBunRuntime() ? 'bun' : 'better-sqlite3'
}

export async function openSqliteConnection(
    options: WaSqliteStorageOptions
): Promise<WaSqliteConnection> {
    const driver = resolveDriver(options.driver)
    const normalizedOptions: WaSqliteStorageOptions = {
        ...options,
        driver,
        pragmas: mergePragmas(options.pragmas)
    }
    const cacheKey = `${driver}|${options.path}|${Object.entries(normalizedOptions.pragmas ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(';')}`
    const cached = SQLITE_CONNECTION_CACHE.get(cacheKey)
    if (cached) {
        return cached
    }

    const onClose = (): void => {
        SQLITE_CONNECTION_CACHE.delete(cacheKey)
    }
    const created =
        driver === 'bun'
            ? openBunSqlite(normalizedOptions, onClose)
            : openBetterSqlite(normalizedOptions, onClose)
    const guarded = created.catch((error) => {
        SQLITE_CONNECTION_CACHE.delete(cacheKey)
        throw error
    })
    SQLITE_CONNECTION_CACHE.set(cacheKey, guarded)
    return guarded
}

const SQLITE_CONNECTION_CACHE = new Map<string, Promise<WaSqliteConnection>>()
