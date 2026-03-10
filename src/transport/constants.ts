export const READY_STATE_CONNECTING = 0
export const READY_STATE_OPEN = 1
export const READY_STATE_CLOSING = 2
export const READY_STATE_CLOSED = 3

export const USER_SERVER = 's.whatsapp.net'
export const GROUP_SERVER = 'g.us'

export const DEFAULT_CHAT_SOCKET_URLS = Object.freeze([
    'wss://web.whatsapp.com/ws/chat',
    'wss://web.whatsapp.com:5222/ws/chat'
] as const)

export const NOISE_RESUME_FAILURES_BEFORE_FULL_HANDSHAKE = 1

export const STREAM_ERROR_NODE_TAG = 'stream:error'
export const XML_STREAM_END_NODE_TAG = 'xmlstreamend'
export const STREAM_ERROR_CONFLICT_TAG = 'conflict'
export const STREAM_ERROR_ACK_TAG = 'ack'
export const STREAM_ERROR_XML_NOT_WELL_FORMED_TAG = 'xml-not-well-formed'
export const STREAM_ERROR_REPLACED_TYPE = 'replaced'
export const STREAM_ERROR_FORCE_LOGIN_CODE = 515
export const STREAM_ERROR_FORCE_LOGOUT_CODE = 516
