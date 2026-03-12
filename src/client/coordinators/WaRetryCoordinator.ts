import type { Logger } from '@infra/log/types'
import { wrapDeviceSentMessage } from '@message/device-sent'
import { unpadPkcs7, writeRandomPadMax16 } from '@message/padding'
import type { WaEncryptedMessageInput } from '@message/types'
import type { WaMessageClient } from '@message/WaMessageClient'
import { proto, type Proto } from '@proto'
import { WA_DEFAULTS, WA_MESSAGE_TAGS } from '@protocol/constants'
import {
    isGroupOrBroadcastJid,
    normalizeDeviceJid,
    parseSignalAddressFromJid,
    toUserJid
} from '@protocol/jid'
import { MAX_RETRY_ATTEMPTS, RETRY_KEYS_MIN_COUNT, RETRY_OUTBOUND_TTL_MS } from '@retry/constants'
import { decodeRetryReplayPayload, pickRetryStateMax } from '@retry/outbound'
import { parseRetryReceiptRequest } from '@retry/parse'
import { mapRetryReasonFromError } from '@retry/reason'
import type {
    WaParsedRetryRequest,
    WaRetryDecryptFailureContext,
    WaRetryEncryptedReplayPayload,
    WaRetryKeyBundle,
    WaRetryOutboundMessageRecord,
    WaRetryOutboundState,
    WaRetryPlaintextReplayPayload,
    WaRetryReplayPayload
} from '@retry/types'
import type { SignalDeviceSyncApi } from '@signal/api/SignalDeviceSyncApi'
import { generatePreKeyPair } from '@signal/registration/keygen'
import type { SignalProtocol } from '@signal/session/SignalProtocol'
import type { WaRetryStore } from '@store/contracts/retry.store'
import type { WaSignalStore } from '@store/contracts/signal.store'
import { decodeBinaryNode } from '@transport/binary'
import { buildRetryAckNode, buildRetryReceiptNode } from '@transport/node/builders/retry'
import { findNodeChild, getNodeChildrenByTag } from '@transport/node/helpers'
import type { BinaryNode } from '@transport/types'
import { toError } from '@util/primitives'

interface WaRetryCoordinatorOptions {
    readonly logger: Logger
    readonly retryStore: WaRetryStore
    readonly signalStore: WaSignalStore
    readonly signalProtocol: SignalProtocol
    readonly signalDeviceSync: SignalDeviceSyncApi
    readonly messageClient: WaMessageClient
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly tryResolvePendingNode?: (node: BinaryNode) => boolean
    readonly getCurrentMeJid: () => string | null | undefined
    readonly getCurrentMeLid: () => string | null | undefined
    readonly getCurrentSignedIdentity: () => Proto.IADVSignedDeviceIdentity | null | undefined
}

type RetryAuthorization =
    | { readonly authorized: true }
    | { readonly authorized: false; readonly reason: string }

type RetryResendResult = 'resent' | 'ineligible'

export class WaRetryCoordinator {
    private readonly logger: Logger
    private readonly retryStore: WaRetryStore
    private readonly signalStore: WaSignalStore
    private readonly signalProtocol: SignalProtocol
    private readonly signalDeviceSync: SignalDeviceSyncApi
    private readonly messageClient: WaMessageClient
    private readonly sendNode: (node: BinaryNode) => Promise<void>
    private readonly tryResolvePendingNode?: (node: BinaryNode) => boolean
    private readonly getCurrentMeJid: () => string | null | undefined
    private readonly getCurrentMeLid: () => string | null | undefined
    private readonly getCurrentSignedIdentity: () =>
        | Proto.IADVSignedDeviceIdentity
        | null
        | undefined
    private readonly retryProcessingByMessageId: Map<string, Promise<void>>

    public constructor(options: WaRetryCoordinatorOptions) {
        this.logger = options.logger
        this.retryStore = options.retryStore
        this.signalStore = options.signalStore
        this.signalProtocol = options.signalProtocol
        this.signalDeviceSync = options.signalDeviceSync
        this.messageClient = options.messageClient
        this.sendNode = options.sendNode
        this.tryResolvePendingNode = options.tryResolvePendingNode
        this.getCurrentMeJid = options.getCurrentMeJid
        this.getCurrentMeLid = options.getCurrentMeLid
        this.getCurrentSignedIdentity = options.getCurrentSignedIdentity
        this.retryProcessingByMessageId = new Map()
    }

    public async onDecryptFailure(
        context: WaRetryDecryptFailureContext,
        error: unknown
    ): Promise<boolean> {
        try {
            await this.retryStore.cleanupExpired(Date.now())

            const registrationInfo = await this.signalStore.getRegistrationInfo()
            if (!registrationInfo) {
                this.logger.warn('retry receipt skipped: missing local registration info', {
                    id: context.stanzaId,
                    from: context.from
                })
                return false
            }

            const requester = context.participant ?? context.from
            const nowMs = Date.now()
            const expiresAtMs = nowMs + RETRY_OUTBOUND_TTL_MS
            const retryCount = await this.retryStore.incrementInboundCounter(
                context.stanzaId,
                requester,
                nowMs,
                expiresAtMs
            )
            const retryKeys =
                retryCount >= RETRY_KEYS_MIN_COUNT
                    ? await this.buildRetryKeysSection(registrationInfo.identityKeyPair.pubKey)
                    : undefined
            const retryReason = mapRetryReasonFromError(error)
            const timestamp = context.t ?? String(Math.trunc(nowMs / 1000))

            const retryReceiptNode = buildRetryReceiptNode({
                stanzaId: context.stanzaId,
                to: context.from,
                participant: context.participant,
                recipient: context.recipient,
                from: this.getCurrentMeJid() ?? undefined,
                originalMsgId: context.stanzaId,
                retryCount,
                t: timestamp,
                registrationId: registrationInfo.registrationId,
                error: retryReason,
                categoryPeer: context.messageNode.attrs.category === 'peer',
                keys: retryKeys
            })
            await this.sendNode(retryReceiptNode)
            this.logger.debug('sent retry receipt for decrypt failure', {
                id: context.stanzaId,
                to: context.from,
                participant: context.participant,
                retryCount,
                reason: retryReason,
                withKeys: retryKeys !== undefined
            })
            return true
        } catch (sendError) {
            this.logger.warn('failed to send retry receipt for decrypt failure', {
                id: context.stanzaId,
                from: context.from,
                participant: context.participant,
                message: toError(sendError).message
            })
            return false
        }
    }

    public async handleIncomingRetryReceipt(receiptNode: BinaryNode): Promise<void> {
        if (receiptNode.tag !== WA_MESSAGE_TAGS.RECEIPT) {
            return
        }
        if (receiptNode.attrs.type !== 'retry' && receiptNode.attrs.type !== 'enc_rekey_retry') {
            return
        }

        try {
            await this.retryStore.cleanupExpired(Date.now())
            const request = parseRetryReceiptRequest(receiptNode)
            if (!request) {
                return
            }
            this.tryResolvePendingNode?.(receiptNode)

            if (request.type === 'enc_rekey_retry') {
                this.logger.info('received enc_rekey_retry request (voip path deferred)', {
                    id: request.stanzaId,
                    originalMsgId: request.originalMsgId,
                    from: request.from,
                    participant: request.participant
                })
                return
            }

            await this.runRetryTaskSerialized(request.originalMsgId, async () => {
                const requesterJid = this.pickRequesterJid(request)
                if (!requesterJid) {
                    this.logger.warn('retry request ignored: missing requester jid', {
                        id: request.stanzaId,
                        originalMsgId: request.originalMsgId
                    })
                    return
                }

                const outbound = await this.retryStore.getOutboundMessage(request.originalMsgId)
                if (!outbound) {
                    this.logger.info('retry request ignored: outbound message not found', {
                        id: request.stanzaId,
                        originalMsgId: request.originalMsgId,
                        requester: requesterJid
                    })
                    return
                }

                const sessionReady = await this.updateLocalSessionFromRetryRequest(
                    request,
                    requesterJid
                )
                if (!sessionReady) {
                    this.logger.info('retry request rejected: missing compatible session', {
                        id: request.stanzaId,
                        originalMsgId: request.originalMsgId,
                        requester: requesterJid
                    })
                    return
                }

                const authorization = await this.authorizeRetryRequest(
                    request,
                    outbound,
                    requesterJid
                )
                if (!authorization.authorized) {
                    this.logger.info('retry request rejected', {
                        id: request.stanzaId,
                        originalMsgId: request.originalMsgId,
                        requester: requesterJid,
                        reason: authorization.reason
                    })
                    return
                }

                const resendResult = await this.resendOutboundMessage(
                    outbound,
                    requesterJid,
                    request.retryCount
                )
                if (resendResult === 'ineligible') {
                    this.logger.info('retry request marked ineligible for resend', {
                        id: request.stanzaId,
                        originalMsgId: request.originalMsgId,
                        requester: requesterJid,
                        mode: outbound.replayMode
                    })
                    return
                }

                this.logger.info('retry request processed and resent', {
                    id: request.stanzaId,
                    originalMsgId: request.originalMsgId,
                    requester: requesterJid,
                    mode: outbound.replayMode
                })
            })
        } catch (error) {
            this.logger.warn('failed handling incoming retry request', {
                id: receiptNode.attrs.id,
                from: receiptNode.attrs.from,
                participant: receiptNode.attrs.participant,
                message: toError(error).message
            })
        } finally {
            await this.sendRetryAckSafe(receiptNode)
        }
    }

    public async trackOutboundReceipt(receiptNode: BinaryNode): Promise<void> {
        if (receiptNode.tag !== WA_MESSAGE_TAGS.RECEIPT) {
            return
        }
        const messageId = receiptNode.attrs.id
        if (!messageId) {
            return
        }
        const receiptType = receiptNode.attrs.type
        if (receiptType === 'retry' || receiptType === 'enc_rekey_retry') {
            return
        }
        const nextState = this.mapOutboundStateFromReceiptType(receiptType)
        if (!nextState) {
            return
        }

        const current = await this.retryStore.getOutboundMessage(messageId)
        if (!current) {
            return
        }
        const merged = pickRetryStateMax(current.state, nextState)
        if (merged === current.state) {
            return
        }
        const nowMs = Date.now()
        await this.retryStore.updateOutboundMessageState(
            messageId,
            merged,
            nowMs,
            nowMs + RETRY_OUTBOUND_TTL_MS
        )
    }

    private async runRetryTaskSerialized(
        messageId: string,
        task: () => Promise<void>
    ): Promise<void> {
        const previous = this.retryProcessingByMessageId.get(messageId) ?? Promise.resolve()
        const current = previous.catch(() => undefined).then(async () => task())
        const tracker = current.then(
            () => undefined,
            () => undefined
        )
        this.retryProcessingByMessageId.set(messageId, tracker)

        try {
            await current
        } finally {
            const latest = this.retryProcessingByMessageId.get(messageId)
            if (latest === tracker) {
                this.retryProcessingByMessageId.delete(messageId)
            }
        }
    }

    private async buildRetryKeysSection(
        identity: Uint8Array
    ): Promise<WaRetryKeyBundle | undefined> {
        const signedPreKey = await this.signalStore.getSignedPreKey()
        if (!signedPreKey) {
            this.logger.warn('retry keys section skipped: signed prekey unavailable')
            return undefined
        }
        const preKey = await this.signalStore.getOrGenSinglePreKey(generatePreKeyPair)
        await this.signalStore.markKeyAsUploaded(preKey.keyId)
        const signedIdentity = this.getCurrentSignedIdentity()
        return {
            identity,
            key: {
                id: preKey.keyId,
                publicKey: preKey.keyPair.pubKey
            },
            skey: {
                id: signedPreKey.keyId,
                publicKey: signedPreKey.keyPair.pubKey,
                signature: signedPreKey.signature
            },
            deviceIdentity: signedIdentity
                ? proto.ADVSignedDeviceIdentity.encode(signedIdentity).finish()
                : undefined
        }
    }

    private pickRequesterJid(request: WaParsedRetryRequest): string | null {
        return request.participant ?? request.from ?? null
    }

    private async updateLocalSessionFromRetryRequest(
        request: WaParsedRetryRequest,
        requesterJid: string
    ): Promise<boolean> {
        const address = parseSignalAddressFromJid(requesterJid)
        const currentSession = await this.signalStore.getSession(address)
        if (currentSession && currentSession.remote.regId !== request.regId) {
            await this.signalStore.deleteSession(address)
        }
        if (request.keyBundle) {
            if (!request.keyBundle.key) {
                return false
            }
            await this.signalProtocol.establishOutgoingSession(address, {
                regId: request.regId,
                identity: request.keyBundle.identity,
                signedKey: {
                    id: request.keyBundle.skey.id,
                    publicKey: request.keyBundle.skey.publicKey,
                    signature: request.keyBundle.skey.signature
                },
                oneTimeKey: {
                    id: request.keyBundle.key.id,
                    publicKey: request.keyBundle.key.publicKey
                }
            })
            return true
        }
        return this.signalProtocol.hasSession(address)
    }

    private async authorizeRetryRequest(
        request: WaParsedRetryRequest,
        outbound: WaRetryOutboundMessageRecord,
        requesterJid: string
    ): Promise<RetryAuthorization> {
        if (request.retryCount >= MAX_RETRY_ATTEMPTS) {
            return { authorized: false, reason: 'retry_count_exceeded' }
        }
        if (
            outbound.state === 'delivered' ||
            outbound.state === 'read' ||
            outbound.state === 'played' ||
            outbound.state === 'ineligible'
        ) {
            return { authorized: false, reason: `state_${outbound.state}` }
        }
        if (!this.matchesRetryTarget(request, outbound)) {
            return { authorized: false, reason: 'chat_target_mismatch' }
        }
        const requesterAuthorized = await this.isRequesterAuthorizedDevice(requesterJid)
        if (!requesterAuthorized) {
            return { authorized: false, reason: 'requester_device_not_authorized' }
        }
        return { authorized: true }
    }

    private matchesRetryTarget(
        request: WaParsedRetryRequest,
        outbound: WaRetryOutboundMessageRecord
    ): boolean {
        const outboundTo = outbound.toJid
        if (isGroupOrBroadcastJid(outboundTo, WA_DEFAULTS.GROUP_SERVER)) {
            return request.from === outboundTo
        }
        try {
            const outboundUser = toUserJid(outboundTo)
            if (outboundUser === toUserJid(request.from)) {
                return true
            }
            if (request.recipient && outboundUser === toUserJid(request.recipient)) {
                return true
            }
        } catch {
            return false
        }
        return false
    }

    private async isRequesterAuthorizedDevice(requesterJid: string): Promise<boolean> {
        try {
            const requesterUser = toUserJid(requesterJid)
            const synced = await this.signalDeviceSync.syncDeviceList([requesterUser])
            const target = synced.find((entry) => entry.jid === requesterUser)
            const authorized = new Set<string>()
            authorized.add(normalizeDeviceJid(requesterUser))
            if (target) {
                for (let index = 0; index < target.deviceJids.length; index += 1) {
                    authorized.add(normalizeDeviceJid(target.deviceJids[index]))
                }
            }
            return authorized.has(normalizeDeviceJid(requesterJid))
        } catch (error) {
            this.logger.warn('retry authorization failed while syncing requester device list', {
                requester: requesterJid,
                message: toError(error).message
            })
            return false
        }
    }

    private async resendOutboundMessage(
        outbound: WaRetryOutboundMessageRecord,
        requesterJid: string,
        retryCount: number
    ): Promise<RetryResendResult> {
        const payload = decodeRetryReplayPayload(outbound.replayPayload)
        if (payload.mode === 'plaintext') {
            return this.resendPlaintextPayload(outbound, payload, requesterJid, retryCount)
        }
        if (payload.mode === 'encrypted') {
            return this.resendEncryptedPayload(outbound, payload, requesterJid, retryCount)
        }
        return this.resendOpaquePayload(outbound, payload, requesterJid)
    }

    private async resendPlaintextPayload(
        outbound: WaRetryOutboundMessageRecord,
        payload: WaRetryPlaintextReplayPayload,
        requesterJid: string,
        retryCount: number
    ): Promise<RetryResendResult> {
        if (isGroupOrBroadcastJid(payload.to, WA_DEFAULTS.GROUP_SERVER)) {
            return this.resendGroupPlaintextPayload(outbound, payload, requesterJid, retryCount)
        }
        if (toUserJid(payload.to) !== toUserJid(requesterJid)) {
            return 'ineligible'
        }

        const encrypted = await this.signalProtocol.encryptMessage(
            parseSignalAddressFromJid(requesterJid),
            payload.plaintext
        )
        await this.messageClient.publishEncrypted({
            to: requesterJid,
            encType: encrypted.type,
            ciphertext: encrypted.ciphertext,
            encCount: retryCount,
            id: outbound.messageId,
            type: payload.type
        })
        return 'resent'
    }

    private async resendGroupPlaintextPayload(
        outbound: WaRetryOutboundMessageRecord,
        payload: WaRetryPlaintextReplayPayload,
        requesterJid: string,
        retryCount: number
    ): Promise<RetryResendResult> {
        const plaintext =
            (await this.maybeWrapGroupRetryPlaintextForSelfDevice(payload, requesterJid)) ??
            payload.plaintext
        const encrypted = await this.signalProtocol.encryptMessage(
            parseSignalAddressFromJid(requesterJid),
            plaintext
        )
        let deviceIdentity: Uint8Array | undefined

        if (encrypted.type === 'pkmsg') {
            const signedIdentity = this.getCurrentSignedIdentity()
            if (!signedIdentity) {
                this.logger.warn(
                    'retry request rejected: missing signed identity for pkmsg group retry'
                )
                return 'ineligible'
            }
            deviceIdentity = proto.ADVSignedDeviceIdentity.encode(signedIdentity).finish()
        }
        const publishInput: WaEncryptedMessageInput = {
            to: payload.to,
            participant: requesterJid,
            encType: encrypted.type,
            ciphertext: encrypted.ciphertext,
            encCount: retryCount,
            id: outbound.messageId,
            type: payload.type,
            deviceIdentity
        }

        await this.messageClient.publishEncrypted(publishInput)
        return 'resent'
    }

    private async resendEncryptedPayload(
        outbound: WaRetryOutboundMessageRecord,
        payload: WaRetryEncryptedReplayPayload,
        requesterJid: string,
        retryCount: number
    ): Promise<RetryResendResult> {
        if (payload.encType === 'skmsg') {
            return 'ineligible'
        }
        if (normalizeDeviceJid(payload.to) !== normalizeDeviceJid(requesterJid)) {
            return 'ineligible'
        }
        await this.messageClient.publishEncrypted({
            to: requesterJid,
            encType: payload.encType,
            ciphertext: payload.ciphertext,
            encCount: retryCount,
            id: outbound.messageId,
            type: payload.type,
            participant: payload.participant
        })
        return 'resent'
    }

    private async resendOpaquePayload(
        outbound: WaRetryOutboundMessageRecord,
        payload: WaRetryReplayPayload,
        requesterJid: string
    ): Promise<RetryResendResult> {
        if (payload.mode !== 'opaque_node') {
            return 'ineligible'
        }
        const decoded = decodeBinaryNode(payload.node)
        const replayNode =
            decoded.attrs.id === outbound.messageId
                ? decoded
                : {
                      ...decoded,
                      attrs: {
                          ...decoded.attrs,
                          id: outbound.messageId
                      }
                  }
        if (!this.isOpaqueReplayCompatible(replayNode, requesterJid)) {
            return 'ineligible'
        }
        await this.messageClient.publishNode(replayNode)
        return 'resent'
    }

    private async maybeWrapGroupRetryPlaintextForSelfDevice(
        payload: WaRetryPlaintextReplayPayload,
        requesterJid: string
    ): Promise<Uint8Array | null> {
        if (!this.isRequesterCurrentAccount(requesterJid)) {
            return null
        }
        try {
            const messageBytes = unpadPkcs7(payload.plaintext)
            const message = proto.Message.decode(messageBytes)
            const wrapped = wrapDeviceSentMessage(message, payload.to)
            return writeRandomPadMax16(proto.Message.encode(wrapped).finish())
        } catch (error) {
            this.logger.warn('retry request failed to wrap deviceSent payload for self requester', {
                requester: requesterJid,
                to: payload.to,
                message: toError(error).message
            })
            return null
        }
    }

    private isRequesterCurrentAccount(requesterJid: string): boolean {
        const requesterUser = toUserJid(requesterJid)
        const meJid = this.getCurrentMeJid()
        if (meJid && toUserJid(meJid) === requesterUser) {
            return true
        }
        const meLid = this.getCurrentMeLid()
        if (meLid && toUserJid(meLid) === requesterUser) {
            return true
        }
        return false
    }

    private isOpaqueReplayCompatible(node: BinaryNode, requesterJid: string): boolean {
        const requester = normalizeDeviceJid(requesterJid)
        const participantsNode = findNodeChild(node, 'participants')
        if (participantsNode) {
            const toNodes = getNodeChildrenByTag(participantsNode, 'to')
            if (toNodes.length !== 1) {
                return false
            }
            const participantJid = toNodes[0].attrs.jid
            if (!participantJid) {
                return false
            }
            return normalizeDeviceJid(participantJid) === requester
        }
        if (node.attrs.participant) {
            return normalizeDeviceJid(node.attrs.participant) === requester
        }
        if (node.attrs.to) {
            return normalizeDeviceJid(node.attrs.to) === requester
        }
        return false
    }

    private mapOutboundStateFromReceiptType(type: string | undefined): WaRetryOutboundState | null {
        if (type === 'read') {
            return 'read'
        }
        if (type === 'played') {
            return 'played'
        }
        if (
            type === undefined ||
            type === '' ||
            type === 'delivery' ||
            type === 'sender' ||
            type === 'inactive' ||
            type === 'peer_msg'
        ) {
            return 'delivered'
        }
        return null
    }

    private async sendRetryAckSafe(receiptNode: BinaryNode): Promise<void> {
        if (!receiptNode.attrs.id || !receiptNode.attrs.from) {
            this.logger.warn('retry ack skipped: missing receipt id/from', {
                hasId: receiptNode.attrs.id !== undefined,
                hasFrom: receiptNode.attrs.from !== undefined,
                participant: receiptNode.attrs.participant,
                type: receiptNode.attrs.type
            })
            return
        }
        try {
            await this.sendNode(buildRetryAckNode(receiptNode))
        } catch (error) {
            this.logger.warn('failed to send retry ack', {
                id: receiptNode.attrs.id,
                from: receiptNode.attrs.from,
                participant: receiptNode.attrs.participant,
                message: toError(error).message
            })
        }
    }
}
