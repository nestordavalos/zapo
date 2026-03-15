import type { WaContactStore, WaStoredContactRecord } from '@store/contracts/contact.store'
import type { WaDeviceListSnapshot, WaDeviceListStore } from '@store/contracts/device-list.store'
import type { WaMessageStore, WaStoredMessageRecord } from '@store/contracts/message.store'
import type {
    WaParticipantsSnapshot,
    WaParticipantsStore
} from '@store/contracts/participants.store'
import type { WaStoredThreadRecord, WaThreadStore } from '@store/contracts/thread.store'

const EMPTY_STORE_LIST = Object.freeze([]) as readonly unknown[]
const DEFAULT_PARTICIPANTS_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_DEVICE_LIST_CACHE_TTL_MS = 5 * 60 * 1000

export const NOOP_MESSAGE_STORE: WaMessageStore = Object.freeze({
    upsert: async (_record: WaStoredMessageRecord): Promise<void> => {},
    getById: async (_id: string): Promise<WaStoredMessageRecord | null> => null,
    listByThread: async (
        _threadJid: string,
        _limit?: number,
        _beforeTimestampMs?: number
    ): Promise<readonly WaStoredMessageRecord[]> =>
        EMPTY_STORE_LIST as readonly WaStoredMessageRecord[],
    deleteById: async (_id: string): Promise<number> => 0,
    clear: async (): Promise<void> => {}
})

export const NOOP_THREAD_STORE: WaThreadStore = Object.freeze({
    upsert: async (_record: WaStoredThreadRecord): Promise<void> => {},
    getByJid: async (_jid: string): Promise<WaStoredThreadRecord | null> => null,
    list: async (_limit?: number): Promise<readonly WaStoredThreadRecord[]> =>
        EMPTY_STORE_LIST as readonly WaStoredThreadRecord[],
    deleteByJid: async (_jid: string): Promise<number> => 0,
    clear: async (): Promise<void> => {}
})

export const NOOP_CONTACT_STORE: WaContactStore = Object.freeze({
    upsert: async (_record: WaStoredContactRecord): Promise<void> => {},
    getByJid: async (_jid: string): Promise<WaStoredContactRecord | null> => null,
    deleteByJid: async (_jid: string): Promise<number> => 0,
    clear: async (): Promise<void> => {}
})

export const NOOP_PARTICIPANTS_STORE: WaParticipantsStore = Object.freeze({
    getTtlMs: (): number => DEFAULT_PARTICIPANTS_CACHE_TTL_MS,
    upsertGroupParticipants: async (_snapshot: WaParticipantsSnapshot): Promise<void> => {},
    getGroupParticipants: async (
        _groupJid: string,
        _nowMs?: number
    ): Promise<WaParticipantsSnapshot | null> => null,
    deleteGroupParticipants: async (_groupJid: string): Promise<number> => 0,
    cleanupExpired: async (_nowMs: number): Promise<number> => 0,
    clear: async (): Promise<void> => {},
    destroy: async (): Promise<void> => {}
})

export const NOOP_DEVICE_LIST_STORE: WaDeviceListStore = Object.freeze({
    getTtlMs: (): number => DEFAULT_DEVICE_LIST_CACHE_TTL_MS,
    upsertUserDevices: async (_snapshot: WaDeviceListSnapshot): Promise<void> => {},
    upsertUserDevicesBatch: async (
        _snapshots: readonly WaDeviceListSnapshot[]
    ): Promise<void> => {},
    getUserDevices: async (
        _userJid: string,
        _nowMs?: number
    ): Promise<WaDeviceListSnapshot | null> => null,
    getUserDevicesBatch: async (
        userJids: readonly string[],
        _nowMs?: number
    ): Promise<readonly (WaDeviceListSnapshot | null)[]> => userJids.map(() => null),
    deleteUserDevices: async (_userJid: string): Promise<number> => 0,
    cleanupExpired: async (_nowMs: number): Promise<number> => 0,
    clear: async (): Promise<void> => {},
    destroy: async (): Promise<void> => {}
})
