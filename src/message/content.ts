import type { WaSendMediaMessage } from '@message/types'
import type { Proto } from '@proto'

export function isSendMediaMessage(content: unknown): content is WaSendMediaMessage {
    return (
        !!content &&
        typeof content === 'object' &&
        'type' in content &&
        'media' in content &&
        'mimetype' in content
    )
}

export function resolveMessageTypeAttr(message: Proto.IMessage): string {
    if (message.reactionMessage) {
        return 'reaction'
    }
    if (
        message.imageMessage ||
        message.videoMessage ||
        message.audioMessage ||
        message.documentMessage ||
        message.stickerMessage
    ) {
        return 'media'
    }
    return 'text'
}
