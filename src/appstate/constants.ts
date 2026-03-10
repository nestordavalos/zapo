import type { AppStateCollectionName } from './types'

export const APP_STATE_HKDF_INFO = 'WhatsApp Mutation Keys'
export const APP_STATE_LT_HASH_SALT = 'WhatsApp Patch Integrity'

export const APP_STATE_DERIVED_KEY_LENGTH = 160
export const APP_STATE_DERIVED_INDEX_KEY_END = 32
export const APP_STATE_DERIVED_VALUE_ENCRYPTION_KEY_END = 64
export const APP_STATE_DERIVED_VALUE_MAC_KEY_END = 96
export const APP_STATE_DERIVED_SNAPSHOT_MAC_KEY_END = 128
export const APP_STATE_DERIVED_PATCH_MAC_KEY_END = 160

export const APP_STATE_VALUE_MAC_LENGTH = 32
export const APP_STATE_MAC_OCTET_LENGTH = 8
export const APP_STATE_IV_LENGTH = 16
export const APP_STATE_LT_HASH_SIZE = 128
export const APP_STATE_POINT_SIZE = 2

export const APP_STATE_OPERATION_SET = 0
export const APP_STATE_OPERATION_REMOVE = 1

export const APP_STATE_EMPTY_LT_HASH = new Uint8Array(APP_STATE_LT_HASH_SIZE)

export const APP_STATE_DEFAULT_COLLECTIONS: readonly AppStateCollectionName[] = [
    'critical_unblock_low',
    'critical_block',
    'regular_low',
    'regular',
    'regular_high'
]

export const APP_STATE_DEFAULT_SYNC_TIMEOUT_MS = 30_000
export const APP_STATE_HOST_DOMAIN = 's.whatsapp.net'
export const APP_STATE_TEXT_ENCODER = new TextEncoder()
export const APP_STATE_TEXT_DECODER = new TextDecoder()
