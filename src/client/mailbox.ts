import type { WaIncomingMessageEvent } from '@client/types'
import type { Logger } from '@infra/log/types'
import { proto } from '@proto'
import type { WaContactStore } from '@store/contracts/contact.store'
import type { WaMessageStore } from '@store/contracts/message.store'
import { toError } from '@util/primitives'

interface WaPersistIncomingMailboxOptions {
    readonly logger: Logger
    readonly contactStore: WaContactStore
    readonly messageStore: WaMessageStore
    readonly event: WaIncomingMessageEvent
}

async function persistContacts(
    contactStore: WaContactStore,
    event: WaIncomingMessageEvent,
    nowMs: number
): Promise<void> {
    const candidateJids = [event.senderJid, event.rawNode.attrs.participant].filter(
        (jid): jid is string => !!jid
    )
    if (candidateJids.length === 0) {
        return
    }

    await Promise.all(
        [...new Set(candidateJids)].map((jid) => contactStore.upsert({ jid, lastUpdatedMs: nowMs }))
    )
}

export async function persistIncomingMailboxEntities(
    options: WaPersistIncomingMailboxOptions
): Promise<void> {
    const { logger, contactStore, messageStore, event } = options
    const { stanzaId, chatJid } = event
    if (!stanzaId || !chatJid) {
        return
    }

    const nowMs = Date.now()
    try {
        const messageBytes = event.message
            ? proto.Message.encode(event.message).finish()
            : undefined
        await Promise.all([
            messageStore.upsert({
                id: stanzaId,
                threadJid: chatJid,
                senderJid: event.senderJid,
                participantJid: event.rawNode.attrs.participant,
                fromMe: false,
                timestampMs:
                    event.timestampSeconds === undefined
                        ? undefined
                        : event.timestampSeconds * 1_000,
                encType: event.encryptionType,
                plaintext: event.plaintext,
                messageBytes
            }),
            persistContacts(contactStore, event, nowMs)
        ])
    } catch (error) {
        logger.warn('failed to persist incoming mailbox entities', {
            id: stanzaId,
            from: chatJid,
            message: toError(error).message
        })
    }
}
