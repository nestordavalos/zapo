import type { WaSignalMessagePublishInput, WaSendMessageOptions } from '@client/types'
import { toSerializedPubKey } from '@crypto/core/keys'
import type { Logger } from '@infra/log/types'
import { resolveMessageTypeAttr } from '@message/content'
import { wrapDeviceSentMessage } from '@message/device-sent'
import { writeRandomPadMax16 } from '@message/padding'
import { computePhashV2 } from '@message/phash'
import type {
    WaEncryptedMessageInput,
    WaMessagePublishOptions,
    WaMessagePublishResult,
    WaSendMessageContent,
    WaSendReceiptInput
} from '@message/types'
import type { WaMessageClient } from '@message/WaMessageClient'
import { proto } from '@proto'
import type { Proto } from '@proto'
import { WA_DEFAULTS } from '@protocol/constants'
import {
    isGroupJid,
    normalizeDeviceJid,
    normalizeRecipientJid,
    parseSignalAddressFromJid,
    splitJid,
    toUserJid
} from '@protocol/jid'
import { RETRY_OUTBOUND_TTL_MS } from '@retry/constants'
import { encodeRetryReplayPayload } from '@retry/outbound'
import { type WaRetryOutboundMessageRecord, type WaRetryReplayPayload } from '@retry/types'
import type { SignalDeviceSyncApi } from '@signal/api/SignalDeviceSyncApi'
import type { SignalIdentitySyncApi } from '@signal/api/SignalIdentitySyncApi'
import type { SignalSessionSyncApi } from '@signal/api/SignalSessionSyncApi'
import type { SenderKeyManager } from '@signal/group/SenderKeyManager'
import type { SignalProtocol } from '@signal/session/SignalProtocol'
import type { SignalAddress } from '@signal/types'
import type { WaParticipantsStore } from '@store/contracts/participants.store'
import type { WaRetryStore } from '@store/contracts/retry.store'
import type { WaSignalStore } from '@store/contracts/signal.store'
import { encodeBinaryNode } from '@transport/binary'
import {
    buildDirectMessageFanoutNode,
    buildGroupDirectMessageNode,
    buildGroupSenderKeyMessageNode
} from '@transport/node/builders/message'
import type { BinaryNode } from '@transport/types'
import { uint8Equal } from '@util/bytes'
import { toError } from '@util/primitives'
import { signalAddressKey } from '@util/signal-address'

interface WaMessageDispatchCoordinatorOptions {
    readonly logger: Logger
    readonly messageClient: WaMessageClient
    readonly retryStore: WaRetryStore
    readonly participantsStore: WaParticipantsStore
    readonly buildMessageContent: (content: WaSendMessageContent) => Promise<Proto.IMessage>
    readonly queryGroupParticipantJids: (groupJid: string) => Promise<readonly string[]>
    readonly senderKeyManager: SenderKeyManager
    readonly signalProtocol: SignalProtocol
    readonly signalStore: WaSignalStore
    readonly signalDeviceSync: SignalDeviceSyncApi
    readonly signalIdentitySync: SignalIdentitySyncApi
    readonly signalSessionSync: SignalSessionSyncApi
    readonly getCurrentMeJid: () => string | null | undefined
    readonly getCurrentMeLid: () => string | null | undefined
    readonly getCurrentSignedIdentity: () => Proto.IADVSignedDeviceIdentity | null | undefined
}

type GroupAddressingMode = 'pn' | 'lid'

interface GroupSendRetryContext {
    readonly retried?: boolean
    readonly forceRefreshParticipants?: boolean
    readonly forceAddressingMode?: GroupAddressingMode
}

export class WaMessageDispatchCoordinator {
    private readonly logger: Logger
    private readonly messageClient: WaMessageClient
    private readonly retryStore: WaRetryStore
    private readonly participantsStore: WaParticipantsStore
    private readonly retryTtlMs: number
    private readonly buildMessageContent: (content: WaSendMessageContent) => Promise<Proto.IMessage>
    private readonly queryGroupParticipantJids: (groupJid: string) => Promise<readonly string[]>
    private readonly senderKeyManager: SenderKeyManager
    private readonly signalProtocol: SignalProtocol
    private readonly signalStore: WaSignalStore
    private readonly signalDeviceSync: SignalDeviceSyncApi
    private readonly signalIdentitySync: SignalIdentitySyncApi
    private readonly signalSessionSync: SignalSessionSyncApi
    private readonly getCurrentMeJid: () => string | null | undefined
    private readonly getCurrentMeLid: () => string | null | undefined
    private readonly getCurrentSignedIdentity: () =>
        | Proto.IADVSignedDeviceIdentity
        | null
        | undefined

    public constructor(options: WaMessageDispatchCoordinatorOptions) {
        this.logger = options.logger
        this.messageClient = options.messageClient
        this.retryStore = options.retryStore
        this.participantsStore = options.participantsStore
        this.retryTtlMs = this.retryStore.getTtlMs?.() ?? RETRY_OUTBOUND_TTL_MS
        this.buildMessageContent = options.buildMessageContent
        this.queryGroupParticipantJids = options.queryGroupParticipantJids
        this.senderKeyManager = options.senderKeyManager
        this.signalProtocol = options.signalProtocol
        this.signalStore = options.signalStore
        this.signalDeviceSync = options.signalDeviceSync
        this.signalIdentitySync = options.signalIdentitySync
        this.signalSessionSync = options.signalSessionSync
        this.getCurrentMeJid = options.getCurrentMeJid
        this.getCurrentMeLid = options.getCurrentMeLid
        this.getCurrentSignedIdentity = options.getCurrentSignedIdentity
    }

    public async publishMessageNode(
        node: BinaryNode,
        options: WaMessagePublishOptions = {}
    ): Promise<WaMessagePublishResult> {
        this.logger.debug('wa client publish message node', {
            tag: node.tag,
            type: node.attrs.type,
            to: node.attrs.to
        })
        const messageType = node.attrs.type ?? 'text'
        const replayPayload: WaRetryReplayPayload = {
            mode: 'opaque_node',
            node: encodeBinaryNode(node)
        }
        return this.publishWithRetryTracking(
            {
                messageIdHint: node.attrs.id,
                toJid: node.attrs.to,
                participantJid: node.attrs.participant,
                recipientJid: node.attrs.recipient,
                messageType,
                replayPayload
            },
            async () => this.messageClient.publishNode(node, options)
        )
    }

    public async publishEncryptedMessage(
        input: WaEncryptedMessageInput,
        options: WaMessagePublishOptions = {}
    ): Promise<WaMessagePublishResult> {
        this.logger.debug('wa client publish encrypted message', {
            to: input.to,
            type: input.type,
            encType: input.encType
        })
        const replayPayload: WaRetryReplayPayload = {
            mode: 'encrypted',
            to: input.to,
            type: input.type ?? 'text',
            encType: input.encType,
            ciphertext: input.ciphertext,
            participant: input.participant
        }
        return this.publishWithRetryTracking(
            {
                messageIdHint: input.id,
                toJid: input.to,
                participantJid: input.participant,
                messageType: input.type ?? 'text',
                replayPayload
            },
            async () => this.messageClient.publishEncrypted(input, options)
        )
    }

    public async publishSignalMessage(
        input: WaSignalMessagePublishInput,
        options: WaMessagePublishOptions = {}
    ): Promise<WaMessagePublishResult> {
        this.requireCurrentMeJid('publishSignalMessage')
        const address = parseSignalAddressFromJid(input.to)
        if (address.server === WA_DEFAULTS.GROUP_SERVER) {
            throw new Error(
                'publishSignalMessage currently supports only direct chats; use sender-key flow for groups'
            )
        }
        this.logger.debug('wa client publish signal message', {
            to: input.to,
            type: input.type
        })
        const [paddedPlaintext] = await Promise.all([
            writeRandomPadMax16(input.plaintext),
            this.ensureSignalSession(address, input.to, input.expectedIdentity)
        ])
        const encrypted = await this.signalProtocol.encryptMessage(
            address,
            paddedPlaintext,
            input.expectedIdentity
        )
        const messageType = input.type ?? 'text'
        const replayPayload: WaRetryReplayPayload = {
            mode: 'plaintext',
            to: input.to,
            type: messageType,
            plaintext: paddedPlaintext
        }
        return this.publishWithRetryTracking(
            {
                messageIdHint: input.id,
                toJid: input.to,
                participantJid: input.participant,
                messageType,
                replayPayload
            },
            async () =>
                this.messageClient.publishEncrypted(
                    {
                        to: input.to,
                        encType: encrypted.type,
                        ciphertext: encrypted.ciphertext,
                        id: input.id,
                        type: input.type,
                        participant: input.participant,
                        deviceFanout: input.deviceFanout
                    },
                    options
                )
        )
    }

    public async sendMessage(
        to: string,
        content: WaSendMessageContent,
        options: WaSendMessageOptions = {}
    ): Promise<WaMessagePublishResult> {
        const recipientJid = normalizeRecipientJid(to)
        const message = await this.buildMessageContent(content)
        const plaintext = await writeRandomPadMax16(proto.Message.encode(message).finish())
        const type = resolveMessageTypeAttr(message)

        if (isGroupJid(recipientJid)) {
            if (this.shouldUseGroupDirectPath(message)) {
                return this.publishGroupDirectMessage(recipientJid, plaintext, type, options)
            }
            return this.publishGroupSenderKeyMessage(recipientJid, plaintext, type, options)
        }

        const directRecipientJid = toUserJid(recipientJid)
        return this.publishDirectSignalMessageWithFanout(
            directRecipientJid,
            message,
            plaintext,
            type,
            options
        )
    }

    public async syncSignalSession(jid: string, reasonIdentity = false): Promise<void> {
        const address = parseSignalAddressFromJid(jid)
        if (address.server === WA_DEFAULTS.GROUP_SERVER) {
            throw new Error('syncSignalSession supports only direct chats')
        }
        await this.ensureSignalSession(address, jid, undefined, reasonIdentity)
    }

    public async sendReceipt(input: WaSendReceiptInput): Promise<void> {
        await this.messageClient.sendReceipt(input)
    }

    private async publishWithRetryTracking(
        args: {
            readonly messageIdHint?: string
            readonly toJid?: string
            readonly participantJid?: string
            readonly recipientJid?: string
            readonly messageType: string
            readonly replayPayload: WaRetryReplayPayload
        },
        publish: () => Promise<WaMessagePublishResult>
    ): Promise<WaMessagePublishResult> {
        const nowMs = Date.now()
        const expiresAtMs = nowMs + this.retryTtlMs
        const hintedMessageId = args.messageIdHint?.trim()
        const resolvedToJid =
            args.toJid ?? (args.replayPayload.mode === 'opaque_node' ? '' : args.replayPayload.to)
        let hintedPersisted = false
        if (hintedMessageId) {
            hintedPersisted = await this.safeUpsertRetryOutboundRecord(
                this.createRetryOutboundRecord({
                    messageId: hintedMessageId,
                    toJid: resolvedToJid,
                    participantJid: args.participantJid,
                    recipientJid: args.recipientJid,
                    messageType: args.messageType,
                    replayPayload: args.replayPayload,
                    createdAtMs: nowMs,
                    updatedAtMs: nowMs,
                    expiresAtMs
                })
            )
        }

        const result = await publish()
        if (hintedPersisted && hintedMessageId && result.id === hintedMessageId) {
            // Hint and final message id matched; avoid a second equivalent upsert on the hot path.
            return result
        }
        const persistedNowMs = Date.now()
        await this.safeUpsertRetryOutboundRecord(
            this.createRetryOutboundRecord({
                messageId: result.id,
                toJid: resolvedToJid,
                participantJid: args.participantJid,
                recipientJid: args.recipientJid,
                messageType: args.messageType,
                replayPayload: args.replayPayload,
                createdAtMs: hintedMessageId ? nowMs : persistedNowMs,
                updatedAtMs: persistedNowMs,
                expiresAtMs: persistedNowMs + this.retryTtlMs
            })
        )
        return result
    }

    private createRetryOutboundRecord(input: {
        readonly messageId: string
        readonly toJid: string
        readonly participantJid?: string
        readonly recipientJid?: string
        readonly messageType: string
        readonly replayPayload: WaRetryReplayPayload
        readonly createdAtMs: number
        readonly updatedAtMs: number
        readonly expiresAtMs: number
    }): WaRetryOutboundMessageRecord {
        return {
            messageId: input.messageId,
            toJid: input.toJid,
            participantJid: input.participantJid,
            recipientJid: input.recipientJid,
            messageType: input.messageType,
            replayMode: input.replayPayload.mode,
            replayPayload: encodeRetryReplayPayload(input.replayPayload),
            state: 'pending',
            createdAtMs: input.createdAtMs,
            updatedAtMs: input.updatedAtMs,
            expiresAtMs: input.expiresAtMs
        }
    }

    private async safeUpsertRetryOutboundRecord(
        record: WaRetryOutboundMessageRecord
    ): Promise<boolean> {
        try {
            await this.retryStore.upsertOutboundMessage(record)
        } catch (error) {
            this.logger.warn('failed to persist retry outbound message record', {
                messageId: record.messageId,
                to: record.toJid,
                mode: record.replayMode,
                message: toError(error).message
            })
            return false
        }

        try {
            await this.retryStore.cleanupExpired(Date.now())
        } catch (error) {
            this.logger.warn('failed to cleanup retry records after outbound persist', {
                message: toError(error).message
            })
        }
        return true
    }

    private shouldUseGroupDirectPath(message: Proto.IMessage): boolean {
        const protocolType = message.protocolMessage?.type
        if (
            protocolType === proto.Message.ProtocolMessage.Type.REVOKE ||
            protocolType === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
        ) {
            return true
        }
        return message.keepInChatMessage?.keepType === proto.KeepType.UNDO_KEEP_FOR_ALL
    }

    private async publishGroupDirectMessage(
        groupJid: string,
        plaintext: Uint8Array,
        type: string,
        options: WaSendMessageOptions,
        retryContext: GroupSendRetryContext = {}
    ): Promise<WaMessagePublishResult> {
        const meJid = this.requireCurrentMeJid('sendMessage')
        const participantUserJids = retryContext.forceRefreshParticipants
            ? await this.refreshGroupParticipantUsers(groupJid)
            : await this.resolveGroupParticipantUsers(groupJid)
        const addressingMode =
            retryContext.forceAddressingMode ??
            this.resolveGroupAddressingMode(participantUserJids, groupJid)
        const senderForPhash = this.resolveSenderForAddressingMode(addressingMode, meJid)
        const fanoutDeviceJids = await this.resolveGroupParticipantDeviceJids(participantUserJids)
        if (fanoutDeviceJids.length === 0) {
            throw new Error('group direct send resolved no target devices')
        }
        await this.ensureSignalSessionsBatch(fanoutDeviceJids)
        const participants = await Promise.all(
            fanoutDeviceJids.map(async (targetJid) => {
                const address = parseSignalAddressFromJid(targetJid)
                await this.ensureSignalSession(address, targetJid)
                const encrypted = await this.signalProtocol.encryptMessage(address, plaintext)
                return {
                    jid: targetJid,
                    encType: encrypted.type,
                    ciphertext: encrypted.ciphertext
                }
            })
        )
        const shouldAttachDeviceIdentity = participants.some(
            (participant) => participant.encType === 'pkmsg'
        )
        const localPhash = await computePhashV2([...fanoutDeviceJids, senderForPhash])
        const messageNode = buildGroupDirectMessageNode({
            to: groupJid,
            type,
            id: options.id,
            phash: localPhash,
            addressingMode,
            participants,
            deviceIdentity: shouldAttachDeviceIdentity
                ? this.getEncodedSignedDeviceIdentity()
                : undefined
        })
        const replayPayload: WaRetryReplayPayload = {
            mode: 'plaintext',
            to: groupJid,
            type,
            plaintext
        }
        const result = await this.publishWithRetryTracking(
            {
                messageIdHint: options.id ?? messageNode.attrs.id,
                toJid: groupJid,
                messageType: type,
                replayPayload
            },
            async () => this.messageClient.publishNode(messageNode, options)
        )
        const ackError = result.ack.error
        const serverPhash = result.ack.phash
        const serverAddressingMode = result.ack.addressingMode
        const hasPhashMismatch = !!serverPhash && serverPhash !== localPhash
        const hasAddressingMismatch =
            !!serverAddressingMode && serverAddressingMode !== addressingMode
        const hasAddressingError = ackError === 421
        if (
            !retryContext.retried &&
            (hasPhashMismatch || hasAddressingMismatch || hasAddressingError)
        ) {
            this.logger.warn('group direct publish acknowledged with mismatch metadata', {
                id: result.id,
                groupJid,
                localPhash,
                serverPhash,
                localAddressingMode: addressingMode,
                serverAddressingMode,
                ackError
            })
            return this.publishGroupDirectMessage(
                groupJid,
                plaintext,
                type,
                {
                    ...options,
                    id: result.id
                },
                {
                    retried: true,
                    forceRefreshParticipants: true,
                    forceAddressingMode: serverAddressingMode
                }
            )
        }
        return result
    }

    private async publishGroupSenderKeyMessage(
        groupJid: string,
        plaintext: Uint8Array,
        type: string,
        options: WaSendMessageOptions,
        retryContext: GroupSendRetryContext = {}
    ): Promise<WaMessagePublishResult> {
        const meJid = this.requireCurrentMeJid('sendMessage')
        const participantUserJids = retryContext.forceRefreshParticipants
            ? await this.refreshGroupParticipantUsers(groupJid)
            : await this.resolveGroupParticipantUsers(groupJid)
        const addressingMode =
            retryContext.forceAddressingMode ??
            this.resolveGroupAddressingMode(participantUserJids, groupJid)
        const senderJid = this.resolveSenderForAddressingMode(addressingMode, meJid)
        const sender = parseSignalAddressFromJid(senderJid)
        const senderKeyDistributionMessage =
            await this.senderKeyManager.createSenderKeyDistributionMessage(groupJid, sender)
        const groupCiphertext = await this.senderKeyManager.encryptGroupMessage(
            groupJid,
            sender,
            plaintext
        )
        const distributionData = await this.encryptGroupDistributionParticipants(
            groupJid,
            sender,
            senderKeyDistributionMessage,
            participantUserJids
        )
        const { fanoutDeviceJids, distributionParticipants } = distributionData
        const shouldAttachDeviceIdentity = distributionParticipants.some(
            (participant) => participant.encType === 'pkmsg'
        )
        const localPhash = await computePhashV2([...fanoutDeviceJids, senderJid])
        const messageNode = buildGroupSenderKeyMessageNode({
            to: groupJid,
            type,
            id: options.id,
            phash: localPhash,
            addressingMode,
            groupCiphertext: groupCiphertext.ciphertext,
            participants: distributionParticipants,
            deviceIdentity: shouldAttachDeviceIdentity
                ? this.getEncodedSignedDeviceIdentity()
                : undefined
        })

        const replayPayload: WaRetryReplayPayload = {
            mode: 'plaintext',
            to: groupJid,
            type,
            plaintext
        }
        const result = await this.publishWithRetryTracking(
            {
                messageIdHint: options.id ?? messageNode.attrs.id,
                toJid: groupJid,
                messageType: type,
                replayPayload
            },
            async () => this.messageClient.publishNode(messageNode, options)
        )
        const distributedAddresses = distributionParticipants.map(
            (participant) => participant.address
        )
        try {
            await this.senderKeyManager.markSenderKeyDistributed(
                groupJid,
                sender,
                distributedAddresses
            )
        } catch (error) {
            this.logger.warn('failed to mark sender key distribution targets', {
                groupJid,
                participants: distributedAddresses.length,
                message: toError(error).message
            })
        }
        const ackError = result.ack.error
        const serverPhash = result.ack.phash
        const serverAddressingMode = result.ack.addressingMode
        const hasPhashMismatch = !!serverPhash && serverPhash !== localPhash
        const hasAddressingMismatch =
            !!serverAddressingMode && serverAddressingMode !== addressingMode
        const hasAddressingError = ackError === 421
        if (
            !retryContext.retried &&
            (hasPhashMismatch || hasAddressingMismatch || hasAddressingError)
        ) {
            this.logger.warn('group message publish acknowledged with mismatch metadata', {
                id: result.id,
                groupJid,
                localPhash,
                serverPhash,
                localAddressingMode: addressingMode,
                serverAddressingMode,
                ackError
            })
            return this.publishGroupSenderKeyMessage(
                groupJid,
                plaintext,
                type,
                {
                    ...options,
                    id: result.id
                },
                {
                    retried: true,
                    forceRefreshParticipants: true,
                    forceAddressingMode: serverAddressingMode
                }
            )
        }
        return result
    }

    private async resolveGroupParticipantUsers(groupJid: string): Promise<readonly string[]> {
        const cached = await this.participantsStore.getGroupParticipants(groupJid)
        if (cached && cached.participants.length > 0) {
            return this.sanitizeParticipantUsers(cached.participants)
        }
        return this.refreshGroupParticipantUsers(groupJid)
    }

    private async refreshGroupParticipantUsers(groupJid: string): Promise<readonly string[]> {
        const queried = await this.queryGroupParticipantJids(groupJid)
        const participants = this.sanitizeParticipantUsers(queried)
        await this.participantsStore.upsertGroupParticipants({
            groupJid,
            participants,
            updatedAtMs: Date.now()
        })
        return participants
    }

    private sanitizeParticipantUsers(participants: readonly string[]): readonly string[] {
        const deduped = new Set<string>()
        for (const participant of participants) {
            if (!participant || !participant.includes('@')) continue
            try {
                deduped.add(toUserJid(participant))
            } catch (error) {
                this.logger.trace('ignoring malformed participant jid', {
                    participant,
                    message: toError(error).message
                })
            }
        }
        return [...deduped]
    }

    private resolveGroupAddressingMode(
        participantUserJids: readonly string[],
        groupJid: string
    ): GroupAddressingMode {
        for (const participantJid of participantUserJids) {
            try {
                if (splitJid(participantJid).server === 'lid') {
                    return 'lid'
                }
            } catch (error) {
                this.logger.trace(
                    'ignoring malformed participant jid in addressing mode resolution',
                    { participantJid, message: toError(error).message }
                )
            }
        }

        this.logger.trace('group addressing mode resolved to pn (default)', {
            groupJid,
            participants: participantUserJids.length
        })
        return 'pn'
    }

    private resolveSenderForAddressingMode(
        addressingMode: GroupAddressingMode,
        meJid: string
    ): string {
        if (addressingMode === 'lid') {
            const meLid = this.getCurrentMeLid()
            if (meLid && meLid.includes('@')) {
                try {
                    return normalizeDeviceJid(meLid)
                } catch (error) {
                    this.logger.trace('ignoring malformed me lid jid', {
                        meLid,
                        message: toError(error).message
                    })
                }
            }
        }
        return normalizeDeviceJid(meJid)
    }

    private async encryptGroupDistributionParticipants(
        groupJid: string,
        sender: SignalAddress,
        senderKeyDistributionMessage: Proto.Message.ISenderKeyDistributionMessage,
        participantUserJids: readonly string[]
    ): Promise<{
        readonly fanoutDeviceJids: readonly string[]
        readonly distributionParticipants: readonly {
            readonly jid: string
            readonly address: SignalAddress
            readonly encType: 'msg' | 'pkmsg'
            readonly ciphertext: Uint8Array
        }[]
    }> {
        const distributionPayload = await writeRandomPadMax16(
            proto.Message.encode({
                senderKeyDistributionMessage
            }).finish()
        )
        const fanoutDeviceJids = await this.resolveGroupParticipantDeviceJids(participantUserJids)
        if (fanoutDeviceJids.length === 0) {
            return {
                fanoutDeviceJids,
                distributionParticipants: []
            }
        }
        const fanoutTargets = fanoutDeviceJids.map((jid) => ({
            jid,
            address: parseSignalAddressFromJid(jid)
        }))
        const pendingAddresses = await this.senderKeyManager.filterParticipantsNeedingDistribution(
            groupJid,
            sender,
            fanoutTargets.map((target) => target.address)
        )
        if (pendingAddresses.length === 0) {
            return {
                fanoutDeviceJids,
                distributionParticipants: []
            }
        }
        const pendingAddressKeys = new Set(pendingAddresses.map(signalAddressKey))
        const pendingTargets = fanoutTargets.filter((target) =>
            pendingAddressKeys.has(signalAddressKey(target.address))
        )
        if (pendingTargets.length === 0) {
            return {
                fanoutDeviceJids,
                distributionParticipants: []
            }
        }
        await this.ensureSignalSessionsBatch(pendingTargets.map((target) => target.jid))
        const distributionParticipants = await Promise.all(
            pendingTargets.map(async (target) => {
                await this.ensureSignalSession(target.address, target.jid)
                const encrypted = await this.signalProtocol.encryptMessage(
                    target.address,
                    distributionPayload
                )
                return {
                    jid: target.jid,
                    address: target.address,
                    encType: encrypted.type,
                    ciphertext: encrypted.ciphertext
                }
            })
        )
        return {
            fanoutDeviceJids,
            distributionParticipants
        }
    }

    private async resolveGroupParticipantDeviceJids(
        participantUserJids: readonly string[]
    ): Promise<readonly string[]> {
        const meDeviceJids = new Set<string>()
        const meJid = this.getCurrentMeJid()
        if (meJid) {
            try {
                meDeviceJids.add(normalizeDeviceJid(meJid))
            } catch (error) {
                this.logger.trace('ignoring malformed me jid', {
                    meJid,
                    message: toError(error).message
                })
            }
        }
        const meLid = this.getCurrentMeLid()
        if (meLid && meLid.includes('@')) {
            try {
                meDeviceJids.add(normalizeDeviceJid(meLid))
            } catch (error) {
                this.logger.trace('ignoring malformed me lid jid', {
                    meLid,
                    message: toError(error).message
                })
            }
        }

        const candidateUsers = [...new Set(participantUserJids)]
        if (candidateUsers.length === 0) {
            return []
        }

        try {
            const synced = await this.signalDeviceSync.syncDeviceList(candidateUsers)
            const fanout = new Set<string>()
            for (const entry of synced) {
                if (entry.deviceJids.length === 0) {
                    const normalizedEntryJid = normalizeDeviceJid(entry.jid)
                    if (meDeviceJids.has(normalizedEntryJid)) continue
                    fanout.add(normalizedEntryJid)
                    continue
                }

                for (const deviceJid of entry.deviceJids) {
                    const normalizedDeviceJid = normalizeDeviceJid(deviceJid)
                    if (meDeviceJids.has(normalizedDeviceJid)) continue
                    fanout.add(normalizedDeviceJid)
                }
            }
            return [...fanout]
        } catch (error) {
            this.logger.warn(
                'group participant device sync failed, falling back to participant user jids',
                {
                    participants: candidateUsers.length,
                    message: toError(error).message
                }
            )
            return [...new Set(candidateUsers.map((jid) => normalizeDeviceJid(jid)))].filter(
                (jid) => !meDeviceJids.has(jid)
            )
        }
    }

    private async publishDirectSignalMessageWithFanout(
        recipientJid: string,
        message: Proto.IMessage,
        plaintext: Uint8Array,
        type: string,
        options: WaSendMessageOptions
    ): Promise<WaMessagePublishResult> {
        const meJid = this.requireCurrentMeJid('sendMessage')
        const meLid = this.getCurrentMeLid()
        const selfDeviceJidForRecipient = this.resolveSelfDeviceJidForRecipient(
            recipientJid,
            meJid,
            meLid
        )
        const deviceJids = await this.resolveDirectFanoutDeviceJids(
            recipientJid,
            selfDeviceJidForRecipient
        )
        const recipientUserJid = toUserJid(recipientJid)
        const meUserJid = toUserJid(selfDeviceJidForRecipient)

        this.logger.debug('wa client publish signal fanout', {
            to: recipientJid,
            devices: deviceJids.length,
            type
        })
        const expectedIdentityByJid = new Map<string, Uint8Array>()
        if (options.expectedIdentity) {
            for (let index = 0; index < deviceJids.length; index += 1) {
                const targetJid = deviceJids[index]
                if (toUserJid(targetJid) === recipientUserJid) {
                    expectedIdentityByJid.set(
                        normalizeDeviceJid(targetJid),
                        options.expectedIdentity
                    )
                }
            }
        }
        await this.ensureSignalSessionsBatch(deviceJids, expectedIdentityByJid)

        const hasSelfDeviceFanout = deviceJids.some(
            (targetJid) => toUserJid(targetJid) === meUserJid
        )
        const selfDevicePlaintext = hasSelfDeviceFanout
            ? await writeRandomPadMax16(
                  proto.Message.encode(wrapDeviceSentMessage(message, recipientUserJid)).finish()
              )
            : null

        const participants: {
            readonly jid: string
            readonly encType: 'msg' | 'pkmsg'
            readonly ciphertext: Uint8Array
        }[] = await Promise.all(
            deviceJids.map(async (targetJid) => {
                const address = parseSignalAddressFromJid(targetJid)
                const targetUserJid = toUserJid(targetJid)
                const expectedIdentity =
                    targetUserJid === recipientUserJid ? options.expectedIdentity : undefined
                const plaintextForTarget =
                    selfDevicePlaintext && targetUserJid === meUserJid
                        ? selfDevicePlaintext
                        : plaintext
                await this.ensureSignalSession(address, targetJid, expectedIdentity)
                const encrypted = await this.signalProtocol.encryptMessage(
                    address,
                    plaintextForTarget,
                    expectedIdentity
                )
                return {
                    jid: targetJid,
                    encType: encrypted.type,
                    ciphertext: encrypted.ciphertext
                }
            })
        )

        const shouldAttachDeviceIdentity = participants.some(
            (participant) => participant.encType === 'pkmsg'
        )
        const deviceIdentity = shouldAttachDeviceIdentity
            ? this.getEncodedSignedDeviceIdentity()
            : undefined
        const messageNode = buildDirectMessageFanoutNode({
            to: recipientJid,
            type,
            id: options.id,
            participants,
            deviceIdentity
        })

        const replayPayload: WaRetryReplayPayload = {
            mode: 'plaintext',
            to: recipientJid,
            type,
            plaintext
        }
        return this.publishWithRetryTracking(
            {
                messageIdHint: options.id ?? messageNode.attrs.id,
                toJid: recipientJid,
                messageType: type,
                replayPayload
            },
            async () => this.messageClient.publishNode(messageNode, options)
        )
    }

    private async ensureSignalSessionsBatch(
        targetJids: readonly string[],
        expectedIdentityByJid: ReadonlyMap<string, Uint8Array> = new Map()
    ): Promise<void> {
        const normalizedTargetJids = [...new Set(targetJids.map((jid) => normalizeDeviceJid(jid)))]
        if (normalizedTargetJids.length === 0) {
            return
        }
        const normalizedTargets = normalizedTargetJids.map((jid) => ({
            jid,
            address: parseSignalAddressFromJid(jid)
        }))
        const hasSessions = await this.signalProtocol.hasSessions(
            normalizedTargets.map((target) => target.address)
        )
        const missingTargets = normalizedTargets.filter((_, index) => !hasSessions[index])

        if (missingTargets.length === 0) {
            return
        }

        try {
            const batchResults = await this.signalSessionSync.fetchKeyBundles(
                missingTargets.map((target) => ({ jid: target.jid }))
            )
            const resultByJid = new Map(
                batchResults.map((result) => [normalizeDeviceJid(result.jid), result] as const)
            )
            const fallbackJids: string[] = []
            const establishPromises: Promise<void>[] = []

            for (let index = 0; index < missingTargets.length; index += 1) {
                const target = missingTargets[index]
                const result = resultByJid.get(target.jid)
                if (!result || !('bundle' in result)) {
                    fallbackJids.push(target.jid)
                    continue
                }

                const expectedIdentity = expectedIdentityByJid.get(target.jid)
                const remoteIdentity = toSerializedPubKey(result.bundle.identity)
                if (
                    expectedIdentity &&
                    !uint8Equal(remoteIdentity, toSerializedPubKey(expectedIdentity))
                ) {
                    throw new Error('identity mismatch')
                }
                establishPromises.push(
                    this.signalProtocol
                        .establishOutgoingSession(target.address, result.bundle)
                        .then(() => {
                            this.logger.debug('signal session synchronized from batch key fetch', {
                                jid: target.jid,
                                regId: result.bundle.regId,
                                hasOneTimeKey: result.bundle.oneTimeKey !== undefined
                            })
                        })
                )
            }
            await Promise.all(establishPromises)

            if (fallbackJids.length === 0) {
                return
            }

            this.logger.warn(
                'signal batch key fetch returned partial errors, falling back to single requests',
                {
                    requested: missingTargets.length,
                    fallbackTargets: fallbackJids.length
                }
            )
            for (let index = 0; index < fallbackJids.length; index += 1) {
                const jid = fallbackJids[index]
                const address = parseSignalAddressFromJid(jid)
                await this.ensureSignalSession(address, jid, expectedIdentityByJid.get(jid))
            }
        } catch (error) {
            const normalized = toError(error)
            if (normalized.message === 'identity mismatch') {
                throw normalized
            }
            this.logger.warn('signal batch key fetch failed, falling back to single requests', {
                requested: missingTargets.length,
                message: normalized.message
            })
            for (let index = 0; index < missingTargets.length; index += 1) {
                const target = missingTargets[index]
                await this.ensureSignalSession(
                    target.address,
                    target.jid,
                    expectedIdentityByJid.get(target.jid)
                )
            }
        }
    }

    private async resolveDirectFanoutDeviceJids(
        recipientJid: string,
        selfDeviceJidForRecipient: string
    ): Promise<readonly string[]> {
        const recipientUserJid = toUserJid(recipientJid)
        const meUserJid = toUserJid(selfDeviceJidForRecipient)
        const targets =
            recipientUserJid === meUserJid ? [recipientUserJid] : [recipientUserJid, meUserJid]

        try {
            const synced = await this.signalDeviceSync.syncDeviceList(targets)
            const byUser = new Map<string, readonly string[]>(
                synced.map((entry) => [toUserJid(entry.jid), entry.deviceJids])
            )

            const fanout = new Set<string>()
            const recipientDevices = byUser.get(recipientUserJid) ?? []
            if (recipientDevices.length === 0) {
                fanout.add(recipientUserJid)
            } else {
                for (let index = 0; index < recipientDevices.length; index += 1) {
                    fanout.add(recipientDevices[index])
                }
            }

            const meDevices = byUser.get(meUserJid) ?? []
            const normalizedMeJid = normalizeDeviceJid(selfDeviceJidForRecipient)
            for (let index = 0; index < meDevices.length; index += 1) {
                const deviceJid = meDevices[index]
                if (normalizeDeviceJid(deviceJid) === normalizedMeJid) {
                    continue
                }
                fanout.add(deviceJid)
            }

            return [...fanout]
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.logger.warn('signal device fanout sync failed, falling back to direct recipient', {
                to: recipientJid,
                message
            })
            return [recipientUserJid]
        }
    }

    private resolveSelfDeviceJidForRecipient(
        recipientJid: string,
        meJid: string,
        meLid: string | null | undefined
    ): string {
        if (splitJid(recipientJid).server !== 'lid') {
            return meJid
        }
        if (!meLid || !meLid.includes('@')) {
            return meJid
        }
        return meLid
    }

    private getEncodedSignedDeviceIdentity(): Uint8Array {
        const signedIdentity = this.getCurrentSignedIdentity()
        if (!signedIdentity) {
            throw new Error('missing signed identity for pkmsg fanout')
        }
        return proto.ADVSignedDeviceIdentity.encode(signedIdentity).finish()
    }

    private async ensureSignalSession(
        address: SignalAddress,
        jid: string,
        expectedIdentity?: Uint8Array,
        reasonIdentity = false
    ): Promise<void> {
        this.requireCurrentMeJid('ensureSignalSession')
        if (reasonIdentity) {
            await this.signalIdentitySync.syncIdentityKeys([jid])
        }
        if (await this.signalProtocol.hasSession(address)) {
            return
        }
        this.logger.info('signal session missing, fetching remote key bundle', { jid })
        const fetched = await this.signalSessionSync.fetchKeyBundle({
            jid,
            reasonIdentity
        })
        const remoteIdentity = toSerializedPubKey(fetched.bundle.identity)
        if (reasonIdentity) {
            const storedIdentity = await this.signalStore.getRemoteIdentity(address)
            if (storedIdentity && !uint8Equal(remoteIdentity, storedIdentity)) {
                throw new Error('identity mismatch')
            }
        }
        if (expectedIdentity && !uint8Equal(remoteIdentity, toSerializedPubKey(expectedIdentity))) {
            throw new Error('identity mismatch')
        }
        await this.signalProtocol.establishOutgoingSession(address, fetched.bundle)
        this.logger.info('signal session synchronized', {
            jid,
            regId: fetched.bundle.regId,
            hasOneTimeKey: fetched.bundle.oneTimeKey !== undefined
        })
    }

    private requireCurrentMeJid(context: string): string {
        const meJid = this.getCurrentMeJid()
        if (meJid) {
            return meJid
        }
        throw new Error(`${context} requires registered meJid`)
    }
}
