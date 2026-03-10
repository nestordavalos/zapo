export const IQ_TIMEOUT_MS = 15_000
export const SUCCESS_NODE_TAG = 'success'
export const INFO_BULLETIN_NODE_TAG = 'ib'
export const INFO_BULLETIN_DIRTY_TAG = 'dirty'
export const INFO_BULLETIN_EDGE_ROUTING_TAG = 'edge_routing'
export const INFO_BULLETIN_ROUTING_INFO_TAG = 'routing_info'
export const DIRTY_BITS_XMLNS = 'urn:xmpp:whatsapp:dirty'
export const DIRTY_TYPE_ACCOUNT_SYNC = 'account_sync'
export const DIRTY_TYPE_GROUPS = 'groups'
export const DIRTY_TYPE_SYNCD_APP_STATE = 'syncd_app_state'
export const DIRTY_TYPE_NEWSLETTER_METADATA = 'newsletter_metadata'
export const DIRTY_PROTOCOL_DEVICES = 'devices'
export const DIRTY_PROTOCOL_PICTURE = 'picture'
export const DIRTY_PROTOCOL_PRIVACY = 'privacy'
export const DIRTY_PROTOCOL_BLOCKLIST = 'blocklist'
export const DIRTY_PROTOCOL_NOTICE = 'notice'
export const ACCOUNT_SYNC_PROTOCOLS = Object.freeze([
    DIRTY_PROTOCOL_DEVICES,
    DIRTY_PROTOCOL_PICTURE,
    DIRTY_PROTOCOL_PRIVACY,
    DIRTY_PROTOCOL_BLOCKLIST,
    DIRTY_PROTOCOL_NOTICE
])
export const SUPPORTED_DIRTY_TYPES = Object.freeze([
    DIRTY_TYPE_ACCOUNT_SYNC,
    DIRTY_TYPE_SYNCD_APP_STATE,
    DIRTY_TYPE_GROUPS,
    DIRTY_TYPE_NEWSLETTER_METADATA
])
export const PROFILE_PICTURE_XMLNS = 'w:profile:picture'
export const PRIVACY_XMLNS = 'privacy'
export const BLOCKLIST_XMLNS = 'blocklist'
export const USYNC_XMLNS = 'usync'
export const USYNC_MODE_QUERY = 'query'
export const USYNC_CONTEXT_NOTIFICATION = 'notification'
export const GROUPS_XMLNS = 'w:g2'
export const NEWSLETTER_XMLNS = 'newsletter'
export const MEDIA_XMLNS = 'w:m'
export const ABT_XMLNS = 'abt'
export const ABPROPS_PROTOCOL_VERSION = '1'
export const MAX_DANGLING_RECEIPTS = 2_048
