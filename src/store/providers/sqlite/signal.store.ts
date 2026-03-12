import {
    decodeSignalPreKeyRow,
    decodeSignalRegistrationRow,
    decodeSignalRemoteIdentity,
    decodeSignalSessionRecord,
    decodeSignalSignedPreKeyRow,
    encodeSignalSessionRecord,
    toSignalAddressParts,
    type SignalIdentityRow,
    type SignalMetaRow,
    type SignalPreKeyRow,
    type SignalRegistrationRow,
    type SignalSessionRow,
    type SignalSignedPreKeyRow
} from '@signal/store/sqlite'
import type {
    PreKeyRecord,
    RegistrationInfo,
    SignalAddress,
    SignalSessionRecord,
    SignedPreKeyRecord
} from '@signal/types'
import { openSqliteConnection, type WaSqliteConnection } from '@store/providers/sqlite/connection'
import { ensureSqliteMigrations } from '@store/providers/sqlite/migrations'
import type { WaSqliteStorageOptions } from '@store/types'
import { asNumber, toBoolOrUndef } from '@util/coercion'

export class WaSignalStore {
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

    public async getRegistrationInfo(): Promise<RegistrationInfo | null> {
        const db = await this.getConnection()
        const row = db.get<SignalRegistrationRow>(
            `SELECT registration_id, identity_pub_key, identity_priv_key
             FROM signal_registration
             WHERE session_id = ?`,
            [this.options.sessionId]
        )
        return row ? decodeSignalRegistrationRow(row) : null
    }

    public async setRegistrationInfo(info: RegistrationInfo): Promise<void> {
        const db = await this.getConnection()
        db.run(
            `INSERT INTO signal_registration (
                session_id,
                registration_id,
                identity_pub_key,
                identity_priv_key
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                registration_id=excluded.registration_id,
                identity_pub_key=excluded.identity_pub_key,
                identity_priv_key=excluded.identity_priv_key`,
            [
                this.options.sessionId,
                info.registrationId,
                info.identityKeyPair.pubKey,
                info.identityKeyPair.privKey
            ]
        )
    }

    public async getSignedPreKey(): Promise<SignedPreKeyRecord | null> {
        const db = await this.getConnection()
        const row = db.get<SignalSignedPreKeyRow>(
            `SELECT key_id, pub_key, priv_key, signature, uploaded
             FROM signal_signed_prekey
             WHERE session_id = ?`,
            [this.options.sessionId]
        )
        return row ? decodeSignalSignedPreKeyRow(row) : null
    }

    public async setSignedPreKey(record: SignedPreKeyRecord): Promise<void> {
        const db = await this.getConnection()
        db.run(
            `INSERT INTO signal_signed_prekey (
                session_id,
                key_id,
                pub_key,
                priv_key,
                signature,
                uploaded
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                key_id=excluded.key_id,
                pub_key=excluded.pub_key,
                priv_key=excluded.priv_key,
                signature=excluded.signature,
                uploaded=excluded.uploaded`,
            [
                this.options.sessionId,
                record.keyId,
                record.keyPair.pubKey,
                record.keyPair.privKey,
                record.signature,
                record.uploaded === true ? 1 : 0
            ]
        )
    }

    public async getSignedPreKeyById(keyId: number): Promise<SignedPreKeyRecord | null> {
        const db = await this.getConnection()
        const row = db.get<SignalSignedPreKeyRow>(
            `SELECT key_id, pub_key, priv_key, signature, uploaded
             FROM signal_signed_prekey
             WHERE session_id = ? AND key_id = ?`,
            [this.options.sessionId, keyId]
        )
        return row ? decodeSignalSignedPreKeyRow(row) : null
    }

    public async putPreKey(record: PreKeyRecord): Promise<void> {
        const db = await this.getConnection()
        this.ensureMetaRow(db)
        this.upsertPreKey(db, record)
        db.run(
            `UPDATE signal_meta
             SET next_prekey_id = MAX(next_prekey_id, ?)
             WHERE session_id = ?`,
            [record.keyId + 1, this.options.sessionId]
        )
    }

    public async getOrGenPreKeys(
        count: number,
        generator: (keyId: number) => PreKeyRecord | Promise<PreKeyRecord>
    ): Promise<readonly PreKeyRecord[]> {
        if (!Number.isSafeInteger(count) || count <= 0) {
            throw new Error(`invalid prekey count: ${count}`)
        }

        const db = await this.getConnection()
        db.exec('BEGIN')
        try {
            this.ensureMetaRow(db)
            const available = db
                .all<SignalPreKeyRow>(
                    `SELECT key_id, pub_key, priv_key, uploaded
                     FROM signal_prekey
                     WHERE session_id = ? AND uploaded = 0
                     ORDER BY key_id ASC
                     LIMIT ?`,
                    [this.options.sessionId, count]
                )
                .map((row) => decodeSignalPreKeyRow(row))

            if (available.length < count) {
                let nextPreKeyId = this.getMeta(db).nextPreKeyId
                while (available.length < count) {
                    const requestedKeyId = nextPreKeyId
                    const generated = await generator(requestedKeyId)
                    this.upsertPreKey(db, generated)
                    available.push(generated)
                    nextPreKeyId = Math.max(requestedKeyId + 1, generated.keyId + 1)
                }
                db.run(
                    `UPDATE signal_meta
                     SET next_prekey_id = ?
                     WHERE session_id = ?`,
                    [nextPreKeyId, this.options.sessionId]
                )
            }

            db.exec('COMMIT')
            return available
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }

    public async getPreKeyById(keyId: number): Promise<PreKeyRecord | null> {
        const db = await this.getConnection()
        const row = db.get<SignalPreKeyRow>(
            `SELECT key_id, pub_key, priv_key, uploaded
             FROM signal_prekey
             WHERE session_id = ? AND key_id = ?`,
            [this.options.sessionId, keyId]
        )
        return row ? decodeSignalPreKeyRow(row) : null
    }

    public async consumePreKeyById(keyId: number): Promise<PreKeyRecord | null> {
        const db = await this.getConnection()
        db.exec('BEGIN')
        try {
            const row = db.get<SignalPreKeyRow>(
                `SELECT key_id, pub_key, priv_key, uploaded
                 FROM signal_prekey
                 WHERE session_id = ? AND key_id = ?`,
                [this.options.sessionId, keyId]
            )
            if (!row) {
                db.exec('COMMIT')
                return null
            }
            db.run(
                `DELETE FROM signal_prekey
                 WHERE session_id = ? AND key_id = ?`,
                [this.options.sessionId, keyId]
            )
            db.exec('COMMIT')
            return decodeSignalPreKeyRow(row)
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
    }

    public async getOrGenSinglePreKey(
        generator: (keyId: number) => PreKeyRecord | Promise<PreKeyRecord>
    ): Promise<PreKeyRecord> {
        const records = await this.getOrGenPreKeys(1, generator)
        return records[0]
    }

    public async markKeyAsUploaded(keyId: number): Promise<void> {
        const db = await this.getConnection()
        const meta = this.getMeta(db)
        if (keyId < 0 || keyId >= meta.nextPreKeyId) {
            throw new Error(`prekey ${keyId} is out of boundary`)
        }
        db.run(
            `UPDATE signal_prekey
             SET uploaded = 1
             WHERE session_id = ? AND key_id <= ?`,
            [this.options.sessionId, keyId]
        )
    }

    public async setServerHasPreKeys(value: boolean): Promise<void> {
        const db = await this.getConnection()
        this.ensureMetaRow(db)
        db.run(
            `UPDATE signal_meta
             SET server_has_prekeys = ?
             WHERE session_id = ?`,
            [value ? 1 : 0, this.options.sessionId]
        )
    }

    public async getServerHasPreKeys(): Promise<boolean> {
        const db = await this.getConnection()
        const meta = this.getMeta(db)
        return meta.serverHasPreKeys
    }

    public async getSession(address: SignalAddress): Promise<SignalSessionRecord | null> {
        const db = await this.getConnection()
        const target = toSignalAddressParts(address)
        const row = db.get<SignalSessionRow>(
            `SELECT user, server, device, record
             FROM signal_session
             WHERE session_id = ? AND user = ? AND server = ? AND device = ?`,
            [this.options.sessionId, target.user, target.server, target.device]
        )
        return row ? decodeSignalSessionRecord(row.record) : null
    }

    public async setSession(address: SignalAddress, session: SignalSessionRecord): Promise<void> {
        const db = await this.getConnection()
        const target = toSignalAddressParts(address)
        db.run(
            `INSERT INTO signal_session (
                session_id,
                user,
                server,
                device,
                record
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id, user, server, device) DO UPDATE SET
                record=excluded.record`,
            [
                this.options.sessionId,
                target.user,
                target.server,
                target.device,
                encodeSignalSessionRecord(session)
            ]
        )
    }

    public async deleteSession(address: SignalAddress): Promise<void> {
        const db = await this.getConnection()
        const target = toSignalAddressParts(address)
        db.run(
            `DELETE FROM signal_session
             WHERE session_id = ? AND user = ? AND server = ? AND device = ?`,
            [this.options.sessionId, target.user, target.server, target.device]
        )
    }

    public async getRemoteIdentity(address: SignalAddress): Promise<Uint8Array | null> {
        const db = await this.getConnection()
        const target = toSignalAddressParts(address)
        const row = db.get<SignalIdentityRow>(
            `SELECT identity_key
             FROM signal_identity
             WHERE session_id = ? AND user = ? AND server = ? AND device = ?`,
            [this.options.sessionId, target.user, target.server, target.device]
        )
        return row ? decodeSignalRemoteIdentity(row.identity_key) : null
    }

    public async setRemoteIdentity(address: SignalAddress, identityKey: Uint8Array): Promise<void> {
        const db = await this.getConnection()
        const target = toSignalAddressParts(address)
        db.run(
            `INSERT INTO signal_identity (
                session_id,
                user,
                server,
                device,
                identity_key
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id, user, server, device) DO UPDATE SET
                identity_key=excluded.identity_key`,
            [this.options.sessionId, target.user, target.server, target.device, identityKey]
        )
    }

    private upsertPreKey(db: WaSqliteConnection, record: PreKeyRecord): void {
        db.run(
            `INSERT INTO signal_prekey (
                session_id,
                key_id,
                pub_key,
                priv_key,
                uploaded
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id, key_id) DO UPDATE SET
                pub_key=excluded.pub_key,
                priv_key=excluded.priv_key,
                uploaded=excluded.uploaded`,
            [
                this.options.sessionId,
                record.keyId,
                record.keyPair.pubKey,
                record.keyPair.privKey,
                record.uploaded === true ? 1 : 0
            ]
        )
    }

    private ensureMetaRow(db: WaSqliteConnection): void {
        db.run(
            `INSERT INTO signal_meta (
                session_id,
                server_has_prekeys,
                next_prekey_id
            ) VALUES (?, 0, 1)
            ON CONFLICT(session_id) DO NOTHING`,
            [this.options.sessionId]
        )
    }

    private getMeta(db: WaSqliteConnection): { serverHasPreKeys: boolean; nextPreKeyId: number } {
        this.ensureMetaRow(db)
        const row = db.get<SignalMetaRow>(
            `SELECT server_has_prekeys, next_prekey_id
             FROM signal_meta
             WHERE session_id = ?`,
            [this.options.sessionId]
        )
        if (!row) {
            return { serverHasPreKeys: false, nextPreKeyId: 1 }
        }
        return {
            serverHasPreKeys: toBoolOrUndef(row.server_has_prekeys) === true,
            nextPreKeyId: asNumber(row.next_prekey_id, 'signal_meta.next_prekey_id')
        }
    }

    private async getConnection(): Promise<WaSqliteConnection> {
        if (!this.connectionPromise) {
            this.connectionPromise = openSqliteConnection(this.options).then((connection) => {
                return ensureSqliteMigrations(connection, ['signal']).then(() => connection)
            })
        }
        return this.connectionPromise
    }
}
