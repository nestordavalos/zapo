import type {
    WaRetryOutboundMessageRecord,
    WaRetryOutboundState
} from '@retry/types'
import type { WaRetryStore } from '@store/contracts/retry.store'
import { openSqliteConnection, type WaSqliteConnection } from '@store/providers/sqlite/connection'
import { ensureSqliteMigrations } from '@store/providers/sqlite/migrations'
import type { WaSqliteStorageOptions } from '@store/types'
import { asBytes, asNumber, asOptionalString, asString } from '@util/coercion'

interface RetryOutboundRow extends Record<string, unknown> {
    readonly message_id: unknown
    readonly to_jid: unknown
    readonly participant_jid: unknown
    readonly recipient_jid: unknown
    readonly message_type: unknown
    readonly replay_mode: unknown
    readonly replay_payload: unknown
    readonly state: unknown
    readonly created_at_ms: unknown
    readonly updated_at_ms: unknown
    readonly expires_at_ms: unknown
}

interface RetryCounterRow extends Record<string, unknown> {
    readonly retry_count: unknown
}

interface CountRow extends Record<string, unknown> {
    readonly total: unknown
}

export class WaRetrySqliteStore implements WaRetryStore {
    private readonly options: WaSqliteStorageOptions
    private connectionPromise: Promise<WaSqliteConnection> | null

    public constructor(options: WaSqliteStorageOptions) {
        if (!options.path || options.path.trim().length === 0) {
            throw new Error('storage.sqlite.path must be a non-empty string')
        }
        if (!options.sessionId || options.sessionId.trim().length === 0) {
            throw new Error('storage.sqlite.sessionId must be a non-empty string')
        }
        this.options = options
        this.connectionPromise = null
    }

    public async upsertOutboundMessage(record: WaRetryOutboundMessageRecord): Promise<void> {
        const db = await this.getConnection()
        db.run(
            `INSERT INTO retry_outbound_messages (
                session_id,
                message_id,
                to_jid,
                participant_jid,
                recipient_jid,
                message_type,
                replay_mode,
                replay_payload,
                state,
                created_at_ms,
                updated_at_ms,
                expires_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, message_id) DO UPDATE SET
                to_jid=excluded.to_jid,
                participant_jid=excluded.participant_jid,
                recipient_jid=excluded.recipient_jid,
                message_type=excluded.message_type,
                replay_mode=excluded.replay_mode,
                replay_payload=excluded.replay_payload,
                state=excluded.state,
                created_at_ms=excluded.created_at_ms,
                updated_at_ms=excluded.updated_at_ms,
                expires_at_ms=excluded.expires_at_ms`,
            [
                this.options.sessionId,
                record.messageId,
                record.toJid,
                record.participantJid ?? null,
                record.recipientJid ?? null,
                record.messageType,
                record.replayMode,
                record.replayPayload,
                record.state,
                record.createdAtMs,
                record.updatedAtMs,
                record.expiresAtMs
            ]
        )
    }

    public async getOutboundMessage(messageId: string): Promise<WaRetryOutboundMessageRecord | null> {
        const db = await this.getConnection()
        const row = db.get<RetryOutboundRow>(
            `SELECT
                message_id,
                to_jid,
                participant_jid,
                recipient_jid,
                message_type,
                replay_mode,
                replay_payload,
                state,
                created_at_ms,
                updated_at_ms,
                expires_at_ms
            FROM retry_outbound_messages
            WHERE session_id = ? AND message_id = ?`,
            [this.options.sessionId, messageId]
        )
        if (!row) {
            return null
        }
        return {
            messageId: asString(row.message_id, 'retry_outbound_messages.message_id'),
            toJid: asString(row.to_jid, 'retry_outbound_messages.to_jid'),
            participantJid: asOptionalString(
                row.participant_jid,
                'retry_outbound_messages.participant_jid'
            ),
            recipientJid: asOptionalString(
                row.recipient_jid,
                'retry_outbound_messages.recipient_jid'
            ),
            messageType: asString(row.message_type, 'retry_outbound_messages.message_type'),
            replayMode: asString(
                row.replay_mode,
                'retry_outbound_messages.replay_mode'
            ) as WaRetryOutboundMessageRecord['replayMode'],
            replayPayload: asBytes(
                row.replay_payload,
                'retry_outbound_messages.replay_payload'
            ),
            state: asString(row.state, 'retry_outbound_messages.state') as WaRetryOutboundState,
            createdAtMs: asNumber(
                row.created_at_ms,
                'retry_outbound_messages.created_at_ms'
            ),
            updatedAtMs: asNumber(
                row.updated_at_ms,
                'retry_outbound_messages.updated_at_ms'
            ),
            expiresAtMs: asNumber(
                row.expires_at_ms,
                'retry_outbound_messages.expires_at_ms'
            )
        }
    }

    public async updateOutboundMessageState(
        messageId: string,
        state: WaRetryOutboundState,
        updatedAtMs: number,
        expiresAtMs: number
    ): Promise<void> {
        const db = await this.getConnection()
        db.run(
            `UPDATE retry_outbound_messages
             SET state = ?, updated_at_ms = ?, expires_at_ms = ?
             WHERE session_id = ? AND message_id = ?`,
            [state, updatedAtMs, expiresAtMs, this.options.sessionId, messageId]
        )
    }

    public async incrementInboundCounter(
        messageId: string,
        requesterJid: string,
        updatedAtMs: number,
        expiresAtMs: number
    ): Promise<number> {
        const db = await this.getConnection()
        db.run(
            `INSERT INTO retry_inbound_counters (
                session_id,
                message_id,
                requester_jid,
                retry_count,
                updated_at_ms,
                expires_at_ms
            ) VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(session_id, message_id, requester_jid) DO UPDATE SET
                retry_count=retry_inbound_counters.retry_count + 1,
                updated_at_ms=excluded.updated_at_ms,
                expires_at_ms=excluded.expires_at_ms`,
            [this.options.sessionId, messageId, requesterJid, updatedAtMs, expiresAtMs]
        )

        const row = db.get<RetryCounterRow>(
            `SELECT retry_count
             FROM retry_inbound_counters
             WHERE session_id = ? AND message_id = ? AND requester_jid = ?`,
            [this.options.sessionId, messageId, requesterJid]
        )
        if (!row) {
            return 1
        }
        return asNumber(row.retry_count, 'retry_inbound_counters.retry_count')
    }

    public async cleanupExpired(nowMs: number): Promise<number> {
        const db = await this.getConnection()
        db.exec('BEGIN')
        try {
            const outboundCount = this.countRows(
                db,
                'retry_outbound_messages',
                nowMs
            )
            const inboundCount = this.countRows(
                db,
                'retry_inbound_counters',
                nowMs
            )
            db.run(
                `DELETE FROM retry_outbound_messages
                 WHERE session_id = ? AND expires_at_ms <= ?`,
                [this.options.sessionId, nowMs]
            )
            db.run(
                `DELETE FROM retry_inbound_counters
                 WHERE session_id = ? AND expires_at_ms <= ?`,
                [this.options.sessionId, nowMs]
            )
            db.exec('COMMIT')
            return outboundCount + inboundCount
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }

    public async clear(): Promise<void> {
        const db = await this.getConnection()
        db.exec('BEGIN')
        try {
            db.run('DELETE FROM retry_outbound_messages WHERE session_id = ?', [
                this.options.sessionId
            ])
            db.run('DELETE FROM retry_inbound_counters WHERE session_id = ?', [
                this.options.sessionId
            ])
            db.exec('COMMIT')
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }

    private countRows(db: WaSqliteConnection, table: string, nowMs: number): number {
        const row = db.get<CountRow>(
            `SELECT COUNT(*) AS total
             FROM ${table}
             WHERE session_id = ? AND expires_at_ms <= ?`,
            [this.options.sessionId, nowMs]
        )
        if (!row) {
            return 0
        }
        return asNumber(row.total, `${table}.count`)
    }

    private async getConnection(): Promise<WaSqliteConnection> {
        if (!this.connectionPromise) {
            this.connectionPromise = openSqliteConnection(this.options).then((connection) => {
                return ensureSqliteMigrations(connection).then(() => connection)
            })
        }
        return this.connectionPromise
    }
}
