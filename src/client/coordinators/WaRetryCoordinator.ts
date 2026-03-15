import type { Logger } from '@infra/log/types'
import type { WaMessageClient } from '@message/WaMessageClient'
import { proto, type Proto } from '@proto'
import { WA_MESSAGE_TAGS } from '@protocol/constants'
import {
    isGroupOrBroadcastJid,
    normalizeDeviceJid,
    parseSignalAddressFromJid,
    toUserJid
} from '@protocol/jid'
import {
    MAX_RETRY_ATTEMPTS,
    RETRY_KEYS_MIN_COUNT,
    RETRY_OUTBOUND_TTL_MS,
    RETRY_REASON
} from '@retry/constants'
import { pickRetryStateMax } from '@retry/outbound'
import { parseRetryReceiptRequest } from '@retry/parse'
import { mapRetryReasonFromError } from '@retry/reason'
import { WaRetryReplayService } from '@retry/replay'
import type {
    WaParsedRetryRequest,
    WaRetryDecryptFailureContext,
    WaRetryKeyBundle,
    WaRetryOutboundMessageRecord,
    WaRetryOutboundState
} from '@retry/types'
import type { SignalDeviceSyncApi } from '@signal/api/SignalDeviceSyncApi'
import type { SignalMissingPreKeysSyncApi } from '@signal/api/SignalMissingPreKeysSyncApi'
import { generatePreKeyPair } from '@signal/registration/keygen'
import type { SignalProtocol } from '@signal/session/SignalProtocol'
import type { SignalPreKeyBundle } from '@signal/types'
import type { WaRetryStore } from '@store/contracts/retry.store'
import type { WaSenderKeyStore } from '@store/contracts/sender-key.store'
import type { WaSignalStore } from '@store/contracts/signal.store'
import { buildInboundRetryReceiptAckNode } from '@transport/node/builders/message'
import { buildRetryReceiptNode } from '@transport/node/builders/retry'
import type { BinaryNode } from '@transport/types'
import { toError } from '@util/primitives'

interface WaRetryCoordinatorOptions {
    readonly logger: Logger
    readonly retryStore: WaRetryStore
    readonly signalStore: WaSignalStore
    readonly senderKeyStore: WaSenderKeyStore
    readonly signalProtocol: SignalProtocol
    readonly signalDeviceSync: SignalDeviceSyncApi
    readonly signalMissingPreKeysSync: SignalMissingPreKeysSyncApi
    readonly messageClient: WaMessageClient
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly getCurrentMeJid: () => string | null | undefined
    readonly getCurrentMeLid: () => string | null | undefined
    readonly getCurrentSignedIdentity: () => Proto.IADVSignedDeviceIdentity | null | undefined
}

type RetryAuthorization =
    | { readonly authorized: true }
    | { readonly authorized: false; readonly reason: string }

interface RetryDecryptFailurePreparation {
    readonly registrationId: number
    readonly retryCount: number
    readonly retryKeys?: WaRetryKeyBundle
    readonly retryReason: number
    readonly timestamp: string
}

interface RetryResendPreparation {
    readonly requesterJid: string
    readonly outbound: WaRetryOutboundMessageRecord
}

function getRetryReasonName(code: number | undefined): string | undefined {
    if (code === undefined) {
        return undefined
    }
    const entry = Object.entries(RETRY_REASON).find(([, value]) => value === code)
    return entry ? entry[0] : 'unknown'
}

function getRemoteRetryReasonLogFields(reason: number | undefined): {
    readonly hasRemoteRetryReason: boolean
    readonly remoteRetryReason: number | null
    readonly remoteRetryReasonName: string
} {
    return {
        hasRemoteRetryReason: reason !== undefined,
        remoteRetryReason: reason ?? null,
        remoteRetryReasonName: getRetryReasonName(reason) ?? 'missing_in_retry_receipt'
    }
}

export class WaRetryCoordinator {
    private readonly logger: Logger
    private readonly retryStore: WaRetryStore
    private readonly retryTtlMs: number
    private readonly signalStore: WaSignalStore
    private readonly senderKeyStore: WaSenderKeyStore
    private readonly signalProtocol: SignalProtocol
    private readonly signalDeviceSync: SignalDeviceSyncApi
    private readonly signalMissingPreKeysSync: SignalMissingPreKeysSyncApi
    private readonly retryReplayService: WaRetryReplayService
    private readonly sendNode: (node: BinaryNode) => Promise<void>
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
        this.retryTtlMs = this.retryStore.getTtlMs?.() ?? RETRY_OUTBOUND_TTL_MS
        this.signalStore = options.signalStore
        this.senderKeyStore = options.senderKeyStore
        this.signalProtocol = options.signalProtocol
        this.signalDeviceSync = options.signalDeviceSync
        this.signalMissingPreKeysSync = options.signalMissingPreKeysSync
        this.sendNode = options.sendNode
        this.getCurrentMeJid = options.getCurrentMeJid
        this.getCurrentMeLid = options.getCurrentMeLid
        this.getCurrentSignedIdentity = options.getCurrentSignedIdentity
        this.retryReplayService = new WaRetryReplayService({
            logger: this.logger,
            messageClient: options.messageClient,
            signalProtocol: this.signalProtocol,
            getCurrentMeJid: this.getCurrentMeJid,
            getCurrentMeLid: this.getCurrentMeLid,
            getCurrentSignedIdentity: this.getCurrentSignedIdentity
        })
        this.retryProcessingByMessageId = new Map()
    }

    public async onDecryptFailure(
        context: WaRetryDecryptFailureContext,
        error: unknown
    ): Promise<boolean> {
        try {
            const prepared = await this.prepareDecryptFailureRetry(context, error)
            if (!prepared) {
                return false
            }
            await this.sendDecryptFailureRetryReceipt(context, prepared)
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
        if (!this.isRetryReceiptNode(receiptNode)) {
            return
        }

        try {
            await this.retryStore.cleanupExpired(Date.now())
            const request = parseRetryReceiptRequest(receiptNode)
            if (!request) {
                return
            }
            await this.handleParsedRetryRequest(receiptNode, request)
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

    private isRetryReceiptNode(node: BinaryNode): boolean {
        return (
            node.tag === WA_MESSAGE_TAGS.RECEIPT &&
            (node.attrs.type === 'retry' || node.attrs.type === 'enc_rekey_retry')
        )
    }

    private async prepareDecryptFailureRetry(
        context: WaRetryDecryptFailureContext,
        error: unknown
    ): Promise<RetryDecryptFailurePreparation | null> {
        const nowMs = Date.now()
        const [, registrationInfo] = await Promise.all([
            this.retryStore.cleanupExpired(nowMs),
            this.signalStore.getRegistrationInfo()
        ])
        if (!registrationInfo) {
            this.logger.warn('retry receipt skipped: missing local registration info', {
                id: context.stanzaId,
                from: context.from
            })
            return null
        }

        const requester = context.participant ?? context.from
        const expiresAtMs = nowMs + this.retryTtlMs
        const retryCount = await this.retryStore.incrementInboundCounter(
            context.stanzaId,
            requester,
            nowMs,
            expiresAtMs
        )
        return {
            registrationId: registrationInfo.registrationId,
            retryCount,
            retryKeys:
                retryCount >= RETRY_KEYS_MIN_COUNT
                    ? await this.buildRetryKeysSection(registrationInfo.identityKeyPair.pubKey)
                    : undefined,
            retryReason: mapRetryReasonFromError(error),
            timestamp: context.t ?? String(Math.trunc(nowMs / 1000))
        }
    }

    private async sendDecryptFailureRetryReceipt(
        context: WaRetryDecryptFailureContext,
        prepared: RetryDecryptFailurePreparation
    ): Promise<void> {
        const retryReceiptNode = buildRetryReceiptNode({
            stanzaId: context.stanzaId,
            to: context.from,
            participant: context.participant,
            recipient: context.recipient,
            from: this.getCurrentMeJid() ?? undefined,
            originalMsgId: context.stanzaId,
            retryCount: prepared.retryCount,
            t: prepared.timestamp,
            registrationId: prepared.registrationId,
            error: prepared.retryReason,
            categoryPeer: context.messageNode.attrs.category === 'peer',
            keys: prepared.retryKeys
        })
        await this.sendNode(retryReceiptNode)
        this.logger.debug('sent retry receipt for decrypt failure', {
            id: context.stanzaId,
            to: context.from,
            participant: context.participant,
            retryCount: prepared.retryCount,
            reason: prepared.retryReason,
            withKeys: prepared.retryKeys !== undefined
        })
    }

    private async handleParsedRetryRequest(
        receiptNode: BinaryNode,
        request: WaParsedRetryRequest
    ): Promise<void> {
        if (request.type === 'enc_rekey_retry') {
            this.logger.info('received enc_rekey_retry request (voip path deferred)', {
                id: request.stanzaId,
                originalMsgId: request.originalMsgId,
                from: request.from,
                participant: request.participant,
                remoteRetryCount: request.retryCount,
                ...getRemoteRetryReasonLogFields(request.retryReason)
            })
            return
        }

        await this.runRetryTaskSerialized(request.originalMsgId, async () => {
            await this.processRetryRequest(request)
        })
    }

    private async processRetryRequest(request: WaParsedRetryRequest): Promise<void> {
        const prepared = await this.prepareRetryResend(request)
        if (!prepared) {
            return
        }
        const resendResult = await this.retryReplayService.resendOutboundMessage(
            prepared.outbound,
            prepared.requesterJid,
            request.retryCount
        )
        if (resendResult === 'ineligible') {
            this.logger.info('retry request marked ineligible for resend', {
                id: request.stanzaId,
                originalMsgId: request.originalMsgId,
                requester: prepared.requesterJid,
                mode: prepared.outbound.replayMode
            })
            return
        }

        this.logger.info('retry request processed and resent', {
            id: request.stanzaId,
            originalMsgId: request.originalMsgId,
            requester: prepared.requesterJid,
            mode: prepared.outbound.replayMode,
            remoteRetryCount: request.retryCount,
            ...getRemoteRetryReasonLogFields(request.retryReason)
        })
    }

    private async prepareRetryResend(
        request: WaParsedRetryRequest
    ): Promise<RetryResendPreparation | null> {
        const requesterJid = request.participant ?? request.from ?? null
        if (!requesterJid) {
            this.logger.warn('retry request ignored: missing requester jid', {
                id: request.stanzaId,
                originalMsgId: request.originalMsgId
            })
            return null
        }

        if (request.retryCount >= MAX_RETRY_ATTEMPTS) {
            this.logger.info('retry request rejected: retry count exceeded', {
                id: request.stanzaId,
                originalMsgId: request.originalMsgId,
                requester: requesterJid,
                remoteRetryCount: request.retryCount,
                ...getRemoteRetryReasonLogFields(request.retryReason)
            })
            return null
        }

        const outbound = await this.retryStore.getOutboundMessage(request.originalMsgId)
        if (!outbound) {
            this.logger.info('retry request ignored: outbound message not found', {
                id: request.stanzaId,
                originalMsgId: request.originalMsgId,
                requester: requesterJid
            })
            return null
        }

        const sessionReady = await this.updateLocalSessionFromRetryRequest(request, requesterJid)
        if (!sessionReady) {
            this.logger.info('retry request rejected: missing compatible session', {
                id: request.stanzaId,
                originalMsgId: request.originalMsgId,
                requester: requesterJid,
                remoteRetryCount: request.retryCount,
                ...getRemoteRetryReasonLogFields(request.retryReason)
            })
            return null
        }

        const authorization = await this.authorizeRetryRequest(request, outbound, requesterJid)
        if (!authorization.authorized) {
            this.logger.info('retry request rejected', {
                id: request.stanzaId,
                originalMsgId: request.originalMsgId,
                requester: requesterJid,
                reason: authorization.reason,
                remoteRetryCount: request.retryCount,
                ...getRemoteRetryReasonLogFields(request.retryReason)
            })
            return null
        }

        return {
            requesterJid,
            outbound
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
            nowMs + this.retryTtlMs
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
        const [signedPreKey, preKey] = await Promise.all([
            this.signalStore.getSignedPreKey(),
            this.signalStore.getOrGenSinglePreKey(generatePreKeyPair)
        ])
        if (!signedPreKey) {
            this.logger.warn('retry keys section skipped: signed prekey unavailable')
            return undefined
        }
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

    private async updateLocalSessionFromRetryRequest(
        request: WaParsedRetryRequest,
        requesterJid: string
    ): Promise<boolean> {
        await this.markRetryRequesterSenderKeyAsStale(request, requesterJid)

        const address = parseSignalAddressFromJid(requesterJid)
        const currentSession = await this.signalStore.getSession(address)
        if (currentSession && request.regId > 0 && currentSession.remote.regId !== request.regId) {
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

        const hasSession = await this.signalProtocol.hasSession(address)
        if (hasSession) {
            return true
        }

        const fetched = await this.fetchMissingPreKeysSession(requesterJid, request.regId)
        if (!fetched) {
            return false
        }
        await this.signalProtocol.establishOutgoingSession(address, fetched)
        return true
    }

    private async markRetryRequesterSenderKeyAsStale(
        request: WaParsedRetryRequest,
        requesterJid: string
    ): Promise<void> {
        if (!isGroupOrBroadcastJid(request.from)) {
            return
        }
        try {
            const requesterAddress = parseSignalAddressFromJid(requesterJid)
            const deleted = await this.senderKeyStore.markForgetSenderKey(request.from, [
                requesterAddress
            ])
            this.logger.debug('marked sender key as stale for group retry requester', {
                groupJid: request.from,
                requester: requesterJid,
                deleted
            })
        } catch (error) {
            this.logger.warn('failed to mark sender key as stale for group retry requester', {
                groupJid: request.from,
                requester: requesterJid,
                message: toError(error).message
            })
        }
    }

    private async fetchMissingPreKeysSession(
        requesterJid: string,
        requesterRegistrationId: number
    ): Promise<SignalPreKeyBundle | null> {
        try {
            const requesterAddress = parseSignalAddressFromJid(requesterJid)
            const results = await this.signalMissingPreKeysSync.fetchMissingPreKeys([
                {
                    userJid: toUserJid(requesterJid),
                    devices: [
                        {
                            deviceId: requesterAddress.device,
                            registrationId: requesterRegistrationId
                        }
                    ]
                }
            ])
            const first = results[0]
            if (!first || !('devices' in first)) {
                this.logger.warn('missing prekeys fetch returned user error', {
                    requester: requesterJid,
                    errorText: first && 'errorText' in first ? first.errorText : 'unknown'
                })
                return null
            }

            const requesterDeviceJid = normalizeDeviceJid(requesterJid)
            const matched = first.devices.find(
                (device) => normalizeDeviceJid(device.deviceJid) === requesterDeviceJid
            )
            if (!matched) {
                this.logger.warn('missing prekeys fetch did not return requested device', {
                    requester: requesterJid,
                    devices: first.devices.length
                })
                return null
            }
            return matched.bundle
        } catch (error) {
            this.logger.warn('failed to fetch missing prekeys for retry requester', {
                requester: requesterJid,
                message: toError(error).message
            })
            return null
        }
    }

    private async authorizeRetryRequest(
        request: WaParsedRetryRequest,
        outbound: WaRetryOutboundMessageRecord,
        requesterJid: string
    ): Promise<RetryAuthorization> {
        if (outbound.state === 'ineligible') {
            return { authorized: false, reason: `state_${outbound.state}` }
        }
        const isGroupOutbound = isGroupOrBroadcastJid(outbound.toJid)
        if (!isGroupOutbound && (outbound.state === 'read' || outbound.state === 'played')) {
            return { authorized: false, reason: `state_${outbound.state}` }
        }
        const requesterAuthorized = await this.isRequesterAuthorizedDevice(requesterJid)
        if (!requesterAuthorized) {
            return { authorized: false, reason: 'requester_device_not_authorized' }
        }
        return { authorized: true }
    }

    private matchesRetryTarget(
        request: WaParsedRetryRequest,
        outbound: WaRetryOutboundMessageRecord,
        requesterJid: string
    ): boolean {
        const outboundTo = outbound.toJid
        if (outboundTo.length === 0) {
            if (outbound.replayMode === 'opaque_node') {
                return true
            }
            this.logger.warn('retry target validation failed: outbound target jid is empty', {
                messageId: outbound.messageId,
                requester: requesterJid,
                mode: outbound.replayMode
            })
            return false
        }
        if (isGroupOrBroadcastJid(outboundTo)) {
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
            await this.sendNode(buildInboundRetryReceiptAckNode(receiptNode))
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
