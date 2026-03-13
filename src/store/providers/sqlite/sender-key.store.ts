import {
    decodeSenderKeyDistributionRow,
    decodeSenderKeyRecord,
    decodeSqliteCount,
    encodeSenderKeyRecord,
    toSignalAddressParts,
    type SenderKeyDistributionRow,
    type SenderKeyRow,
    type SignalAddressParts,
    type SqliteCountRow
} from '@signal/store/sqlite'
import type { SenderKeyDistributionRecord, SenderKeyRecord, SignalAddress } from '@signal/types'
import type { WaSenderKeyStore as WaSenderKeyStoreContract } from '@store/contracts/sender-key.store'
import { BaseSqliteStore } from '@store/providers/sqlite/BaseSqliteStore'
import type { WaSqliteConnection } from '@store/providers/sqlite/connection'
import type { WaSqliteStorageOptions } from '@store/types'
import { asNumber, asString } from '@util/coercion'

export class SenderKeySqliteStore extends BaseSqliteStore implements WaSenderKeyStoreContract {
    public constructor(options: WaSqliteStorageOptions) {
        super(options, ['senderKey'])
    }

    public async upsertSenderKey(record: SenderKeyRecord): Promise<void> {
        const db = await this.getConnection()
        const sender = toSignalAddressParts(record.sender)
        db.run(
            `INSERT INTO sender_keys (
                session_id,
                group_id,
                sender_user,
                sender_server,
                sender_device,
                record
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, group_id, sender_user, sender_server, sender_device) DO UPDATE SET
                record=excluded.record`,
            [
                this.options.sessionId,
                record.groupId,
                sender.user,
                sender.server,
                sender.device,
                encodeSenderKeyRecord(record)
            ]
        )
    }

    public async upsertSenderKeyDistribution(record: SenderKeyDistributionRecord): Promise<void> {
        const db = await this.getConnection()
        const sender = toSignalAddressParts(record.sender)
        db.run(
            `INSERT INTO sender_key_distribution (
                session_id,
                group_id,
                sender_user,
                sender_server,
                sender_device,
                key_id,
                timestamp_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, group_id, sender_user, sender_server, sender_device) DO UPDATE SET
                key_id=excluded.key_id,
                timestamp_ms=excluded.timestamp_ms`,
            [
                this.options.sessionId,
                record.groupId,
                sender.user,
                sender.server,
                sender.device,
                record.keyId,
                record.timestampMs
            ]
        )
    }

    public async getGroupSenderKeyList(groupId: string): Promise<{
        readonly skList: readonly SenderKeyRecord[]
        readonly skDistribList: readonly SenderKeyDistributionRecord[]
    }> {
        const db = await this.getConnection()
        const senderRows = db.all<SenderKeyRow>(
            `SELECT group_id, sender_user, sender_server, sender_device, record
             FROM sender_keys
             WHERE session_id = ? AND group_id = ?`,
            [this.options.sessionId, groupId]
        )
        const distributionRows = db.all<SenderKeyDistributionRow>(
            `SELECT group_id, sender_user, sender_server, sender_device, key_id, timestamp_ms
             FROM sender_key_distribution
             WHERE session_id = ? AND group_id = ?`,
            [this.options.sessionId, groupId]
        )

        return {
            skList: senderRows.map((row) =>
                decodeSenderKeyRecord(row.record, asString(row.group_id, 'sender_keys.group_id'), {
                    user: asString(row.sender_user, 'sender_keys.sender_user'),
                    server: asString(row.sender_server, 'sender_keys.sender_server'),
                    device: asNumber(row.sender_device, 'sender_keys.sender_device')
                })
            ),
            skDistribList: distributionRows.map((row) => decodeSenderKeyDistributionRow(row))
        }
    }

    public async getDeviceSenderKey(
        groupId: string,
        sender: SignalAddress
    ): Promise<SenderKeyRecord | null> {
        const db = await this.getConnection()
        const target = toSignalAddressParts(sender)
        const row = db.get<SenderKeyRow>(
            `SELECT group_id, sender_user, sender_server, sender_device, record
             FROM sender_keys
             WHERE session_id = ?
               AND group_id = ?
               AND sender_user = ?
               AND sender_server = ?
               AND sender_device = ?`,
            [this.options.sessionId, groupId, target.user, target.server, target.device]
        )
        if (!row) {
            return null
        }
        return decodeSenderKeyRecord(row.record, asString(row.group_id, 'sender_keys.group_id'), {
            user: asString(row.sender_user, 'sender_keys.sender_user'),
            server: asString(row.sender_server, 'sender_keys.sender_server'),
            device: asNumber(row.sender_device, 'sender_keys.sender_device')
        })
    }

    public async getDeviceSenderKeyDistribution(
        groupId: string,
        sender: SignalAddress
    ): Promise<SenderKeyDistributionRecord | null> {
        const db = await this.getConnection()
        const target = toSignalAddressParts(sender)
        const row = db.get<SenderKeyDistributionRow>(
            `SELECT group_id, sender_user, sender_server, sender_device, key_id, timestamp_ms
             FROM sender_key_distribution
             WHERE session_id = ?
               AND group_id = ?
               AND sender_user = ?
               AND sender_server = ?
               AND sender_device = ?`,
            [this.options.sessionId, groupId, target.user, target.server, target.device]
        )
        return row ? decodeSenderKeyDistributionRow(row) : null
    }

    public async deleteDeviceSenderKey(target: SignalAddress, groupId?: string): Promise<number> {
        const db = await this.getConnection()
        const sender = toSignalAddressParts(target)
        db.exec('BEGIN')
        try {
            const senderCount = this.countDelete(db, 'sender_keys', sender, groupId)
            const distributionCount = this.countDelete(
                db,
                'sender_key_distribution',
                sender,
                groupId
            )
            db.exec('COMMIT')
            return senderCount + distributionCount
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }

    public async markForgetSenderKey(
        groupId: string,
        participants: readonly SignalAddress[]
    ): Promise<number> {
        if (participants.length === 0) {
            return 0
        }
        return this.withTransaction(async (db) => {
            let deleted = 0
            for (const participant of participants) {
                const sender = toSignalAddressParts(participant)
                deleted += this.countDelete(db, 'sender_keys', sender, groupId)
                deleted += this.countDelete(db, 'sender_key_distribution', sender, groupId)
            }
            return deleted
        })
    }

    private countDelete(
        db: WaSqliteConnection,
        table: 'sender_keys' | 'sender_key_distribution',
        target: SignalAddressParts,
        groupId?: string
    ): number {
        const whereWithGroup =
            'session_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ? AND group_id = ?'
        const whereAllGroups =
            'session_id = ? AND sender_user = ? AND sender_server = ? AND sender_device = ?'

        const countRow = db.get<SqliteCountRow>(
            `SELECT COUNT(*) AS count
             FROM ${table}
             WHERE ${groupId ? whereWithGroup : whereAllGroups}`,
            groupId
                ? [this.options.sessionId, target.user, target.server, target.device, groupId]
                : [this.options.sessionId, target.user, target.server, target.device]
        )
        const count = decodeSqliteCount(countRow, `${table}.count`)
        if (count === 0) {
            return 0
        }

        db.run(
            `DELETE FROM ${table}
             WHERE ${groupId ? whereWithGroup : whereAllGroups}`,
            groupId
                ? [this.options.sessionId, target.user, target.server, target.device, groupId]
                : [this.options.sessionId, target.user, target.server, target.device]
        )
        return count
    }
}
