export const MESSAGE_NODE_TAG = 'message'
export const MESSAGE_ENC_TAG = 'enc'
export const MESSAGE_ENC_VERSION = '2'
export const MESSAGE_MEDIA_NOTIFY_TYPE = 'medianotify'
export const RECEIPT_NODE_TAG = 'receipt'
export const ACK_NODE_TAG = 'ack'
export const ERROR_NODE_TAG = 'error'

export const ACK_ATTR_TYPE = 'type'
export const ACK_ATTR_CLASS = 'class'
export const ACK_ATTR_CODE = 'code'

export const ACK_TYPE_ERROR = 'error'
export const ACK_CLASS_ERROR = 'error'
export const ACK_CLASS_MESSAGE = 'message'
export const RECEIPT_TYPE_PEER = 'peer_msg'

export const RETRYABLE_ACK_CODES = ['408', '429', '500', '503'] as const

export const DEFAULT_MESSAGE_ACK_TIMEOUT_MS = 10_000
export const DEFAULT_MESSAGE_MAX_ATTEMPTS = 3
export const DEFAULT_MESSAGE_RETRY_DELAY_MS = 750
