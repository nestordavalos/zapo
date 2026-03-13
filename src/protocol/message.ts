export const WA_MESSAGE_TAGS = Object.freeze({
    MESSAGE: 'message',
    ENC: 'enc',
    RECEIPT: 'receipt',
    ACK: 'ack',
    ERROR: 'error'
} as const)

export const WA_MESSAGE_TYPES = Object.freeze({
    ENC_VERSION: '2',
    MEDIA_NOTIFY: 'medianotify',
    ACK_TYPE_ERROR: 'error',
    ACK_CLASS_ERROR: 'error',
    ACK_CLASS_MESSAGE: 'message',
    RECEIPT_TYPE_PEER: 'peer_msg'
} as const)

export const WA_RETRYABLE_ACK_CODES = Object.freeze(['408', '429', '500', '503'] as const)
