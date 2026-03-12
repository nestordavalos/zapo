import type { WaSqliteConnection } from '@store/providers/sqlite/connection'

type WaSqliteMigrationDomain = 'auth' | 'signal' | 'senderKey' | 'appState' | 'retry'

interface WaSqliteMigration {
    readonly id: string
    readonly domain: WaSqliteMigrationDomain
    readonly up: (db: WaSqliteConnection) => void
}

interface SqliteTableInfoRow extends Record<string, unknown> {
    readonly name: unknown
}

function hasTableColumn(db: WaSqliteConnection, table: string, column: string): boolean {
    return db
        .all<SqliteTableInfoRow>(`PRAGMA table_info(${table})`)
        .some((row) => row.name === column)
}

function addColumnIfMissing(
    db: WaSqliteConnection,
    table: string,
    column: string,
    definition: string
): void {
    if (hasTableColumn(db, table, column)) {
        return
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

const SQLITE_MIGRATIONS: readonly WaSqliteMigration[] = [
    {
        id: '0001_auth_credentials_schema',
        domain: 'auth',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS auth_credentials (
                    session_id TEXT PRIMARY KEY,
                    noise_pub_key BLOB NOT NULL,
                    noise_priv_key BLOB NOT NULL,
                    registration_id INTEGER NOT NULL,
                    identity_pub_key BLOB NOT NULL,
                    identity_priv_key BLOB NOT NULL,
                    signed_prekey_id INTEGER NOT NULL,
                    signed_prekey_pub_key BLOB NOT NULL,
                    signed_prekey_priv_key BLOB NOT NULL,
                    signed_prekey_signature BLOB NOT NULL,
                    adv_secret_key BLOB NOT NULL,
                    signed_identity BLOB,
                    me_jid TEXT,
                    me_lid TEXT,
                    me_display_name TEXT,
                    companion_enc_static BLOB,
                    platform TEXT,
                    server_static_key BLOB,
                    server_has_prekeys INTEGER,
                    routing_info BLOB,
                    last_success_ts INTEGER,
                    props_version INTEGER,
                    ab_props_version INTEGER,
                    connection_location TEXT,
                    account_creation_ts INTEGER
                );
            `)
        }
    },
    {
        id: '0001_signal_schema',
        domain: 'signal',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS signal_meta (
                    session_id TEXT PRIMARY KEY,
                    server_has_prekeys INTEGER NOT NULL DEFAULT 0,
                    next_prekey_id INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS signal_registration (
                    session_id TEXT PRIMARY KEY,
                    registration_id INTEGER NOT NULL,
                    identity_pub_key BLOB NOT NULL,
                    identity_priv_key BLOB NOT NULL
                );

                CREATE TABLE IF NOT EXISTS signal_signed_prekey (
                    session_id TEXT PRIMARY KEY,
                    key_id INTEGER NOT NULL,
                    pub_key BLOB NOT NULL,
                    priv_key BLOB NOT NULL,
                    signature BLOB NOT NULL,
                    uploaded INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS signal_prekey (
                    session_id TEXT NOT NULL,
                    key_id INTEGER NOT NULL,
                    pub_key BLOB NOT NULL,
                    priv_key BLOB NOT NULL,
                    uploaded INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, key_id)
                );

                CREATE TABLE IF NOT EXISTS signal_session (
                    session_id TEXT NOT NULL,
                    user TEXT NOT NULL,
                    server TEXT NOT NULL,
                    device INTEGER NOT NULL,
                    record BLOB NOT NULL,
                    PRIMARY KEY (session_id, user, server, device)
                );

                CREATE TABLE IF NOT EXISTS signal_identity (
                    session_id TEXT NOT NULL,
                    user TEXT NOT NULL,
                    server TEXT NOT NULL,
                    device INTEGER NOT NULL,
                    identity_key BLOB NOT NULL,
                    PRIMARY KEY (session_id, user, server, device)
                );
            `)
        }
    },
    {
        id: '0001_sender_key_schema',
        domain: 'senderKey',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS sender_keys (
                    session_id TEXT NOT NULL,
                    group_id TEXT NOT NULL,
                    sender_user TEXT NOT NULL,
                    sender_server TEXT NOT NULL,
                    sender_device INTEGER NOT NULL,
                    record BLOB NOT NULL,
                    PRIMARY KEY (session_id, group_id, sender_user, sender_server, sender_device)
                );

                CREATE TABLE IF NOT EXISTS sender_key_distribution (
                    session_id TEXT NOT NULL,
                    group_id TEXT NOT NULL,
                    sender_user TEXT NOT NULL,
                    sender_server TEXT NOT NULL,
                    sender_device INTEGER NOT NULL,
                    key_id INTEGER NOT NULL,
                    timestamp_ms INTEGER NOT NULL,
                    PRIMARY KEY (session_id, group_id, sender_user, sender_server, sender_device)
                );
            `)
        }
    },
    {
        id: '0001_appstate_schema',
        domain: 'appState',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS appstate_sync_keys (
                    session_id TEXT NOT NULL,
                    key_id BLOB NOT NULL,
                    key_data BLOB NOT NULL,
                    timestamp INTEGER NOT NULL,
                    fingerprint BLOB,
                    PRIMARY KEY (session_id, key_id)
                );

                CREATE TABLE IF NOT EXISTS appstate_collection_versions (
                    session_id TEXT NOT NULL,
                    collection TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    hash BLOB NOT NULL,
                    PRIMARY KEY (session_id, collection)
                );

                CREATE TABLE IF NOT EXISTS appstate_collection_index_values (
                    session_id TEXT NOT NULL,
                    collection TEXT NOT NULL,
                    index_mac_hex TEXT NOT NULL,
                    value_mac BLOB NOT NULL,
                    PRIMARY KEY (session_id, collection, index_mac_hex)
                );
            `)
        }
    },
    {
        id: '0002_appstate_syncd_parity_schema',
        domain: 'appState',
        up: (db) => {
            addColumnIfMissing(db, 'appstate_collection_versions', 'state', 'TEXT')
            addColumnIfMissing(
                db,
                'appstate_collection_versions',
                'finite_failure_start_time',
                'INTEGER'
            )
            addColumnIfMissing(
                db,
                'appstate_collection_versions',
                'is_collection_in_mac_mismatch_fatal',
                'INTEGER'
            )
            addColumnIfMissing(db, 'appstate_sync_keys', 'key_epoch', 'INTEGER')

            db.exec(`
                CREATE TABLE IF NOT EXISTS appstate_sync_actions (
                    session_id TEXT NOT NULL,
                    index_value TEXT NOT NULL,
                    key_id BLOB,
                    version INTEGER,
                    action_state TEXT,
                    model_id TEXT,
                    model_type TEXT,
                    value_mac BLOB,
                    index_mac BLOB,
                    collection TEXT,
                    timestamp INTEGER,
                    action TEXT,
                    binary_sync_action BLOB,
                    binary_sync_data BLOB,
                    PRIMARY KEY (session_id, index_value)
                );

                CREATE INDEX IF NOT EXISTS appstate_sync_actions_by_state
                    ON appstate_sync_actions (session_id, action_state);
                CREATE INDEX IF NOT EXISTS appstate_sync_actions_by_index_mac
                    ON appstate_sync_actions (session_id, index_mac);
                CREATE INDEX IF NOT EXISTS appstate_sync_actions_by_collection
                    ON appstate_sync_actions (session_id, collection);
                CREATE INDEX IF NOT EXISTS appstate_sync_actions_by_action
                    ON appstate_sync_actions (session_id, action);
                CREATE INDEX IF NOT EXISTS appstate_sync_actions_by_model_info
                    ON appstate_sync_actions (session_id, model_id, model_type, action_state);

                CREATE TABLE IF NOT EXISTS appstate_pending_mutations (
                    session_id TEXT NOT NULL,
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collection TEXT NOT NULL,
                    index_value TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    version INTEGER NOT NULL,
                    operation INTEGER NOT NULL,
                    binary_sync_action BLOB NOT NULL,
                    action TEXT
                );

                CREATE INDEX IF NOT EXISTS appstate_pending_mutations_by_index
                    ON appstate_pending_mutations (session_id, index_value);
                CREATE INDEX IF NOT EXISTS appstate_pending_mutations_by_collection
                    ON appstate_pending_mutations (session_id, collection);
                CREATE INDEX IF NOT EXISTS appstate_pending_mutations_by_action
                    ON appstate_pending_mutations (session_id, action);

                CREATE TABLE IF NOT EXISTS appstate_missing_keys (
                    session_id TEXT NOT NULL,
                    key_hex TEXT NOT NULL,
                    key_id BLOB NOT NULL,
                    timestamp INTEGER NOT NULL,
                    device_responses BLOB,
                    PRIMARY KEY (session_id, key_hex)
                );

                CREATE TABLE IF NOT EXISTS appstate_syncd_logs (
                    session_id TEXT NOT NULL,
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER NOT NULL,
                    collection TEXT NOT NULL,
                    log TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS appstate_syncd_logs_by_collection
                    ON appstate_syncd_logs (session_id, collection);

                CREATE INDEX IF NOT EXISTS appstate_sync_keys_by_key_epoch
                    ON appstate_sync_keys (session_id, key_epoch);
            `)
        }
    },
    {
        id: '0003_retry_message_schema',
        domain: 'retry',
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS retry_outbound_messages (
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    to_jid TEXT NOT NULL,
                    participant_jid TEXT,
                    recipient_jid TEXT,
                    message_type TEXT NOT NULL,
                    replay_mode TEXT NOT NULL,
                    replay_payload BLOB NOT NULL,
                    state TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    expires_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (session_id, message_id)
                );

                CREATE INDEX IF NOT EXISTS retry_outbound_messages_by_expiry
                    ON retry_outbound_messages (session_id, expires_at_ms);
                CREATE INDEX IF NOT EXISTS retry_outbound_messages_by_state
                    ON retry_outbound_messages (session_id, state);

                CREATE TABLE IF NOT EXISTS retry_inbound_counters (
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    requester_jid TEXT NOT NULL,
                    retry_count INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    expires_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (session_id, message_id, requester_jid)
                );

                CREATE INDEX IF NOT EXISTS retry_inbound_counters_by_expiry
                    ON retry_inbound_counters (session_id, expires_at_ms);
            `)
        }
    }
]

interface SqliteMigrationRow extends Record<string, unknown> {
    readonly id: unknown
}

function isMigrationAlreadyAppliedRace(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false
    }
    return error.message.includes('UNIQUE constraint failed: wa_migrations.id')
}

function ensureMigrationTable(db: WaSqliteConnection): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS wa_migrations (
            id TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
    `)
}

function hasMigration(db: WaSqliteConnection, id: string): boolean {
    const row = db.get<SqliteMigrationRow>(
        `SELECT id
         FROM wa_migrations
         WHERE id = ?`,
        [id]
    )
    return !!row
}

function hasDomain(domainSet: ReadonlySet<WaSqliteMigrationDomain>, migration: WaSqliteMigration): boolean {
    return domainSet.has(migration.domain)
}

export async function ensureSqliteMigrations(
    db: WaSqliteConnection,
    domains: readonly WaSqliteMigrationDomain[]
): Promise<void> {
    ensureMigrationTable(db)
    const domainSet = new Set(domains)
    if (domainSet.size === 0) {
        return
    }

    for (const migration of SQLITE_MIGRATIONS) {
        if (!hasDomain(domainSet, migration)) {
            continue
        }
        if (hasMigration(db, migration.id)) {
            continue
        }

        db.exec('BEGIN')
        try {
            if (hasMigration(db, migration.id)) {
                db.exec('COMMIT')
                continue
            }
            db.run(
                `INSERT INTO wa_migrations (id, applied_at)
                 VALUES (?, ?)`,
                [migration.id, Date.now()]
            )
            migration.up(db)
            db.exec('COMMIT')
        } catch (error) {
            db.exec('ROLLBACK')
            if (isMigrationAlreadyAppliedRace(error)) {
                continue
            }
            throw error
        }
    }
}
