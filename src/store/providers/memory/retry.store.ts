import type { WaRetryOutboundMessageRecord, WaRetryOutboundState } from '@retry/types'
import type { WaRetryStore } from '@store/contracts/retry.store'

interface RetryInboundCounterRecord {
    count: number
    expiresAtMs: number
}

export class WaRetryMemoryStore implements WaRetryStore {
    private readonly outboundMessages: Map<string, WaRetryOutboundMessageRecord>
    private readonly inboundCounters: Map<string, RetryInboundCounterRecord>

    public constructor() {
        this.outboundMessages = new Map()
        this.inboundCounters = new Map()
    }

    public async upsertOutboundMessage(record: WaRetryOutboundMessageRecord): Promise<void> {
        this.outboundMessages.set(record.messageId, record)
    }

    public async getOutboundMessage(
        messageId: string
    ): Promise<WaRetryOutboundMessageRecord | null> {
        return this.outboundMessages.get(messageId) ?? null
    }

    public async updateOutboundMessageState(
        messageId: string,
        state: WaRetryOutboundState,
        updatedAtMs: number,
        expiresAtMs: number
    ): Promise<void> {
        const current = this.outboundMessages.get(messageId)
        if (!current) {
            return
        }
        this.outboundMessages.set(messageId, {
            ...current,
            state,
            updatedAtMs,
            expiresAtMs
        })
    }

    public async incrementInboundCounter(
        messageId: string,
        requesterJid: string,
        _updatedAtMs: number,
        expiresAtMs: number
    ): Promise<number> {
        const key = this.counterKey(messageId, requesterJid)
        const current = this.inboundCounters.get(key)
        const count = current ? current.count + 1 : 1
        this.inboundCounters.set(key, {
            count,
            expiresAtMs
        })
        return count
    }

    public async cleanupExpired(nowMs: number): Promise<number> {
        let removed = 0

        for (const [messageId, record] of this.outboundMessages.entries()) {
            if (record.expiresAtMs > nowMs) {
                continue
            }
            this.outboundMessages.delete(messageId)
            removed += 1
        }
        for (const [key, record] of this.inboundCounters.entries()) {
            if (record.expiresAtMs > nowMs) {
                continue
            }
            this.inboundCounters.delete(key)
            removed += 1
        }
        return removed
    }

    public async clear(): Promise<void> {
        this.outboundMessages.clear()
        this.inboundCounters.clear()
    }

    private counterKey(messageId: string, requesterJid: string): string {
        return `${messageId}|${requesterJid}`
    }
}
