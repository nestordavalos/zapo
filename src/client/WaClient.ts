import { EventEmitter } from 'node:events'

import type { WaAppStateStoreData, WaAppStateSyncResult } from '../appstate/types'
import type { WaAppStateSyncOptions } from '../appstate/types'
import { downloadExternalBlobReference } from '../appstate/utils'
import { WaAppStateSyncClient } from '../appstate/WaAppStateSyncClient'
import { DEFAULT_DEVICE_PLATFORM, HOST_DOMAIN } from '../auth/flow/constants'
import { WaPairingCodeCrypto } from '../auth/pairing/WaPairingCodeCrypto'
import type { WaAuthCredentials } from '../auth/types'
import { WaAuthClient } from '../auth/WaAuthClient'
import { randomBytesAsync } from '../crypto'
import { toSerializedPubKey } from '../crypto/core/keys'
import { X25519 } from '../crypto/curves/X25519'
import { ConsoleLogger } from '../infra/log/Logger'
import type { Logger } from '../infra/log/types'
import { MEDIA_CONN_CACHE_GRACE_MS, MEDIA_UPLOAD_PATHS } from '../media/constants'
import { WaMediaCrypto } from '../media/WaMediaCrypto'
import { WaMediaTransferClient } from '../media/WaMediaTransferClient'
import { RECEIPT_NODE_TAG } from '../message/constants'
import { asMediaBytes, isSendMediaMessage, resolveMessageTypeAttr } from '../message/content'
import { handleIncomingMessageAck } from '../message/incoming'
import type {
    WaEncryptedMessageInput,
    WaIncomingMessageAckHandlerOptions,
    WaMessagePublishOptions,
    WaMessagePublishResult,
    WaSendReceiptInput
} from '../message/types'
import { WaMessageClient } from '../message/WaMessageClient'
import type { Proto } from '../proto'
import { proto } from '../proto'
import { SIGNAL_UPLOAD_PREKEYS_COUNT } from '../signal/api/constants'
import { SignalSessionSyncApi } from '../signal/api/SignalSessionSyncApi'
import { generatePreKeyPair } from '../signal/api/utils'
import { WaAdvSignature } from '../signal/crypto/WaAdvSignature'
import { SenderKeyManager } from '../signal/group/SenderKeyManager'
import { SenderKeyStore } from '../signal/group/SenderKeyStore'
import { SignalProtocol } from '../signal/session/SignalProtocol'
import { WaSignalStore } from '../signal/store/WaSignalStore'
import type { SignalAddress } from '../signal/types'
import { GROUP_SERVER, USER_SERVER } from '../transport/constants'
import { WaKeepAlive } from '../transport/keepalive/WaKeepAlive'
import {
    decodeBinaryNodeContent,
    findNodeChild,
    getNodeChildrenByTag
} from '../transport/node/helpers'
import {
    assertIqResult,
    buildIqNode,
    queryWithContext as queryNodeWithContext
} from '../transport/node/query'
import { WaIncomingNodeRouter } from '../transport/node/WaIncomingNodeRouter'
import { WaNodeOrchestrator } from '../transport/node/WaNodeOrchestrator'
import { WaNodeTransport } from '../transport/node/WaNodeTransport'
import type { BinaryNode } from '../transport/types'
import { WaComms } from '../transport/WaComms'
import { bytesToBase64UrlSafe } from '../util/base64'
import { uint8Equal } from '../util/bytes'
import { toError } from '../util/errors'

import {
    ABPROPS_PROTOCOL_VERSION,
    ABT_XMLNS,
    MAX_DANGLING_RECEIPTS,
    DIRTY_PROTOCOL_BLOCKLIST,
    DIRTY_PROTOCOL_DEVICES,
    DIRTY_PROTOCOL_NOTICE,
    DIRTY_PROTOCOL_PICTURE,
    DIRTY_PROTOCOL_PRIVACY,
    DIRTY_TYPE_ACCOUNT_SYNC,
    DIRTY_TYPE_GROUPS,
    DIRTY_TYPE_NEWSLETTER_METADATA,
    DIRTY_TYPE_SYNCD_APP_STATE,
    INFO_BULLETIN_DIRTY_TAG,
    INFO_BULLETIN_EDGE_ROUTING_TAG,
    INFO_BULLETIN_NODE_TAG,
    INFO_BULLETIN_ROUTING_INFO_TAG,
    IQ_TIMEOUT_MS,
    SUCCESS_NODE_TAG
} from './constants'
import {
    isGroupJid,
    normalizeRecipientJid,
    parseSignalAddressFromJid
} from './jid'
import { buildMediaConnIq, parseMediaConnResponse } from './media'
import { buildPreKeyUploadIq, parsePreKeyUploadFailure } from './prekeys'
import {
    handleParsedStreamControl,
    parseStreamControlNode,
    parseSuccessPersistAttributes
} from './stream'
import {
    buildAccountBlocklistSyncIq,
    buildAccountDevicesSyncIq,
    buildAccountPictureSyncIq,
    buildAccountPrivacySyncIq,
    buildClearDirtyBitsIq,
    buildGroupsDirtySyncIq,
    buildNewsletterMetadataSyncIq,
    parseDirtyBitNode,
    resolveAccountSyncProtocols,
    splitDirtyBitsBySupport
} from './sync'
import type {
    WaClientEventMap,
    WaClientOptions,
    WaDirtyBit,
    WaMediaConn,
    WaSendMediaMessage,
    WaSendMessageContent,
    WaSendMessageOptions,
    WaSignalMessagePublishInput,
    WaStreamControlNodeResult
} from './types'

const TEXT_DECODER = new TextDecoder()

export class WaClient extends EventEmitter {
    private readonly options: Readonly<WaClientOptions>
    private readonly logger: Logger
    private readonly signalStore: WaSignalStore
    private readonly x25519: X25519
    private readonly authClient: WaAuthClient
    private readonly nodeOrchestrator: WaNodeOrchestrator
    private readonly keepAlive: WaKeepAlive
    private readonly incomingNodeRouter: WaIncomingNodeRouter
    private readonly nodeTransport: WaNodeTransport
    private readonly appStateSync: WaAppStateSyncClient
    private readonly mediaCrypto: WaMediaCrypto
    private readonly mediaTransfer: WaMediaTransferClient
    private readonly messageClient: WaMessageClient
    private readonly senderKeyManager: SenderKeyManager
    private readonly signalProtocol: SignalProtocol
    private readonly signalSessionSync: SignalSessionSyncApi
    private clockSkewMs: number | null
    private mediaConnCache: WaMediaConn | null
    private comms: WaComms | null
    private pairingReconnectPromise: Promise<void> | null
    private streamControlLifecyclePromise: Promise<void> | null
    private passiveTasksPromise: Promise<void> | null
    private mediaConnWarmupPromise: Promise<void> | null
    private readonly danglingReceipts: BinaryNode[]
    private abPropsHash: string | null
    private abPropsRefreshId: number | null

    public constructor(
        options: WaClientOptions,
        logger: Logger = new ConsoleLogger('info'),
        signalStore = new WaSignalStore()
    ) {
        super()
        this.options = Object.freeze({
            ...options,
            devicePlatform: options.devicePlatform ?? DEFAULT_DEVICE_PLATFORM
        })
        this.logger = logger
        this.signalStore = signalStore
        this.comms = null
        this.pairingReconnectPromise = null
        this.streamControlLifecyclePromise = null
        this.passiveTasksPromise = null
        this.mediaConnWarmupPromise = null
        this.danglingReceipts = []
        this.abPropsHash = null
        this.abPropsRefreshId = null
        this.clockSkewMs = null
        this.mediaConnCache = null

        this.nodeTransport = new WaNodeTransport(this.logger)
        this.nodeTransport.on('frame_in', (frame) => this.emit('frame_in', frame))
        this.nodeTransport.on('frame_out', (frame) => this.emit('frame_out', frame))
        this.nodeTransport.on('node_in', (node, frame) => this.emit('node_in', node, frame))
        this.nodeTransport.on('node_out', (node, frame) => this.emit('node_out', node, frame))
        this.nodeTransport.on('decode_error', (error, frame) => {
            this.emit('decode_error', error, frame)
            this.handleError(error)
        })
        this.nodeOrchestrator = new WaNodeOrchestrator({
            sendNode: async (node) => this.nodeTransport.sendNode(node),
            logger: this.logger,
            defaultTimeoutMs: IQ_TIMEOUT_MS,
            hostDomain: HOST_DOMAIN
        })
        this.keepAlive = new WaKeepAlive({
            logger: this.logger,
            nodeOrchestrator: this.nodeOrchestrator,
            getComms: () => this.comms,
            hostDomain: HOST_DOMAIN
        })

        this.mediaCrypto = new WaMediaCrypto()
        this.mediaTransfer = new WaMediaTransferClient({
            logger: this.logger,
            mediaCrypto: this.mediaCrypto
        })
        this.messageClient = new WaMessageClient({
            logger: this.logger,
            sendNode: async (node) => this.sendNode(node),
            query: async (node, timeoutMs) => this.query(node, timeoutMs)
        })
        this.senderKeyManager = new SenderKeyManager(new SenderKeyStore())

        this.x25519 = new X25519()
        const advSignature = new WaAdvSignature()
        this.signalProtocol = new SignalProtocol(signalStore, this.x25519)
        this.signalSessionSync = new SignalSessionSyncApi({
            logger: this.logger,
            query: async (node, timeoutMs) => this.query(node, timeoutMs)
        })
        this.authClient = new WaAuthClient(
            {
                authPath: this.options.authPath,
                devicePlatform: this.options.devicePlatform
            },
            {
                logger: this.logger,
                signalStore,
                x25519: this.x25519,
                pairingCrypto: new WaPairingCodeCrypto(this.x25519),
                advSignature,
                sendNode: async (node) => this.sendNode(node),
                query: async (node, timeoutMs) => this.query(node, timeoutMs),
                callbacks: {
                    onQr: (qr, ttlMs) => this.emit('qr', qr, ttlMs),
                    onPairingCode: (code) => this.emit('pairing_code', code),
                    onPairingRefresh: (forceManual) => this.emit('pairing_refresh', forceManual),
                    onPaired: (credentials) => {
                        this.emit('paired', credentials)
                        this.scheduleReconnectAfterPairing()
                    },
                    onError: (error) => this.handleError(error)
                }
            }
        )
        const incomingMessageAckOptions: WaIncomingMessageAckHandlerOptions = {
            logger: this.logger,
            sendNode: async (node) => this.sendNode(node),
            getMeJid: () => this.authClient.getCurrentCredentials()?.meJid
        }

        this.incomingNodeRouter = new WaIncomingNodeRouter({
            nodeOrchestrator: this.nodeOrchestrator,
            iqSetHandlers: [async (node) => this.authClient.handleIncomingIqSet(node)],
            notificationHandlers: [
                async (node) => this.authClient.handleLinkCodeNotification(node),
                async (node) => this.authClient.handleCompanionRegRefreshNotification(node)
            ],
            messageHandlers: [
                async (node) => handleIncomingMessageAck(node, incomingMessageAckOptions)
            ]
        })
        this.appStateSync = new WaAppStateSyncClient({
            logger: this.logger,
            query: async (node, timeoutMs) => this.query(node, timeoutMs),
            getPersistedAppState: () => this.authClient.getCurrentCredentials()?.appState,
            persistAppState: async (next) => this.authClient.persistAppState(next)
        })
    }

    public override on<K extends keyof WaClientEventMap>(
        event: K,
        listener: WaClientEventMap[K]
    ): this {
        return super.on(event, listener as (...args: unknown[]) => void)
    }

    public getState() {
        const connected = this.comms !== null && this.comms.getCommsState().connected
        this.logger.trace('wa client state requested', { connected })
        return this.authClient.getState(connected)
    }

    public getCredentials() {
        return this.authClient.getCredentials()
    }

    public getClockSkewMs(): number | null {
        return this.clockSkewMs
    }

    public async sendNode(node: BinaryNode): Promise<void> {
        this.logger.trace('wa client sendNode', { tag: node.tag, id: node.attrs.id })
        try {
            await this.nodeOrchestrator.sendNode(node)
        } catch (error) {
            const normalized = toError(error)
            if (this.shouldQueueDanglingReceipt(node, normalized)) {
                this.enqueueDanglingReceipt(node)
                this.logger.warn('queued dangling receipt after send failure', {
                    id: node.attrs.id,
                    to: node.attrs.to,
                    message: normalized.message,
                    queueSize: this.danglingReceipts.length
                })
                return
            }
            throw normalized
        }
    }

    public async query(node: BinaryNode, timeoutMs = IQ_TIMEOUT_MS): Promise<BinaryNode> {
        if (!this.comms || !this.comms.getCommsState().connected) {
            throw new Error('client is not connected')
        }
        this.logger.debug('wa client query', { tag: node.tag, id: node.attrs.id, timeoutMs })
        return this.nodeOrchestrator.query(node, timeoutMs)
    }

    private async queryWithContext(
        context: string,
        node: BinaryNode,
        timeoutMs = IQ_TIMEOUT_MS,
        contextData: Readonly<Record<string, unknown>> = {}
    ): Promise<BinaryNode> {
        return queryNodeWithContext(
            async (queryNode, queryTimeoutMs) => this.query(queryNode, queryTimeoutMs),
            this.logger,
            context,
            node,
            timeoutMs,
            contextData
        )
    }

    public async connect(): Promise<void> {
        if (this.comms) {
            this.logger.trace('wa client connect skipped: comms already created')
            return
        }

        this.logger.info('wa client connect start')
        let credentials = await this.authClient.loadOrCreateCredentials()
        try {
            await this.startCommsWithCredentials(credentials)
        } catch (error) {
            if (credentials.routingInfo) {
                this.logger.warn('connect failed with routing info, retrying without routing info', {
                    message: toError(error).message
                })
                await this.disconnect()
                credentials = await this.authClient.clearRoutingInfo()
                await this.startCommsWithCredentials(credentials)
            } else {
                throw error
            }
        }
        this.logger.info('wa client connected')
        this.emit('connected')
    }

    public async disconnect(): Promise<void> {
        this.logger.info('wa client disconnect start')
        this.keepAlive.stop()
        await this.authClient.clearTransientState()
        this.nodeOrchestrator.clearPending(new Error('client disconnected'))
        this.clockSkewMs = null
        this.mediaConnCache = null
        this.passiveTasksPromise = null

        const comms = this.comms
        this.comms = null
        this.nodeTransport.bindComms(null)
        if (comms) {
            await comms.stopComms()
            this.logger.info('wa client disconnected')
            this.emit('disconnected')
        }
    }

    public async requestPairingCode(
        phoneNumber: string,
        shouldShowPushNotification = false
    ): Promise<string> {
        if (!this.comms || !this.authClient.getCurrentCredentials()) {
            throw new Error('client is not connected')
        }
        this.logger.debug('wa client request pairing code')
        return this.authClient.requestPairingCode(phoneNumber, shouldShowPushNotification)
    }

    public async fetchPairingCountryCodeIso(): Promise<string> {
        if (!this.comms || !this.authClient.getCurrentCredentials()) {
            throw new Error('client is not connected')
        }
        this.logger.trace('wa client fetch pairing country code iso')
        return this.authClient.fetchPairingCountryCodeIso()
    }

    public getAppStateSyncClient(): WaAppStateSyncClient {
        return this.appStateSync
    }

    public getMediaTransferClient(): WaMediaTransferClient {
        return this.mediaTransfer
    }

    public getMessageClient(): WaMessageClient {
        return this.messageClient
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
        return this.messageClient.publishNode(node, options)
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
        return this.messageClient.publishEncrypted(input, options)
    }

    public async publishSignalMessage(
        input: WaSignalMessagePublishInput,
        options: WaMessagePublishOptions = {}
    ): Promise<WaMessagePublishResult> {
        const address = parseSignalAddressFromJid(input.to)
        if (address.server === GROUP_SERVER) {
            throw new Error(
                'publishSignalMessage currently supports only direct chats; use sender-key flow for groups'
            )
        }
        this.logger.debug('wa client publish signal message', {
            to: input.to,
            type: input.type
        })
        await this.ensureSignalSession(address, input.to, input.expectedIdentity)
        const encrypted = await this.signalProtocol.encryptMessage(
            address,
            input.plaintext,
            input.expectedIdentity
        )
        return this.messageClient.publishEncrypted(
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
    }

    public async sendMessage(
        to: string,
        content: WaSendMessageContent,
        options: WaSendMessageOptions = {}
    ): Promise<WaMessagePublishResult> {
        const recipientJid = normalizeRecipientJid(to, USER_SERVER, GROUP_SERVER)
        const message = await this.buildMessageContent(content)
        const plaintext = proto.Message.encode(message).finish()
        const type = resolveMessageTypeAttr(message)

        if (isGroupJid(recipientJid, GROUP_SERVER)) {
            const meJid = this.authClient.getCurrentCredentials()?.meJid
            if (!meJid) {
                throw new Error('group send requires registered meJid')
            }
            const sender = parseSignalAddressFromJid(meJid)
            const encrypted = await this.senderKeyManager.encryptGroupMessage(
                recipientJid,
                sender,
                plaintext
            )
            return this.publishEncryptedMessage(
                {
                    to: recipientJid,
                    encType: 'skmsg',
                    ciphertext: encrypted.ciphertext,
                    id: options.id,
                    type
                },
                options
            )
        }

        return this.publishSignalMessage(
            {
                to: recipientJid,
                plaintext,
                expectedIdentity: options.expectedIdentity,
                id: options.id,
                type
            },
            options
        )
    }

    public async syncSignalSession(jid: string, reasonIdentity = false): Promise<void> {
        const address = parseSignalAddressFromJid(jid)
        if (address.server === GROUP_SERVER) {
            throw new Error('syncSignalSession supports only direct chats')
        }
        await this.ensureSignalSession(address, jid, undefined, reasonIdentity)
    }

    public async sendReceipt(input: WaSendReceiptInput): Promise<void> {
        return this.messageClient.sendReceipt(input)
    }

    public exportAppState(): WaAppStateStoreData {
        return this.appStateSync.exportState()
    }

    public async importAppStateSyncKeyShare(
        share: Proto.Message.IAppStateSyncKeyShare
    ): Promise<number> {
        return this.appStateSync.importSyncKeyShare(share)
    }

    public async syncAppState(options: WaAppStateSyncOptions = {}): Promise<WaAppStateSyncResult> {
        if (!this.comms) {
            throw new Error('client is not connected')
        }
        if (options.downloadExternalBlob) {
            return this.appStateSync.sync(options)
        }
        return this.appStateSync.sync({
            ...options,
            downloadExternalBlob: async (_collection, _kind, reference) =>
                downloadExternalBlobReference(this.mediaTransfer, reference)
        })
    }

    private async buildMessageContent(content: WaSendMessageContent): Promise<Proto.IMessage> {
        if (typeof content === 'string') {
            return {
                conversation: content
            }
        }
        if (isSendMediaMessage(content)) {
            return this.buildMediaMessage(content)
        }
        if (!content || typeof content !== 'object') {
            throw new Error('invalid message content')
        }
        return content
    }

    private async buildMediaMessage(content: WaSendMediaMessage): Promise<Proto.IMessage> {
        const mediaBytes = asMediaBytes(content.media)
        const uploaded = await this.uploadMedia(content, mediaBytes)
        const mediaKeyTimestamp = Math.floor(Date.now() / 1000)
        const common = {
            url: uploaded.url,
            mimetype: content.mimetype,
            fileSha256: uploaded.fileSha256,
            fileLength: mediaBytes.byteLength,
            mediaKey: uploaded.mediaKey,
            fileEncSha256: uploaded.fileEncSha256,
            directPath: uploaded.directPath,
            mediaKeyTimestamp
        }

        switch (content.type) {
            case 'image':
                return {
                    imageMessage: {
                        ...common,
                        caption: content.caption,
                        width: content.width,
                        height: content.height
                    }
                }
            case 'video':
                return {
                    videoMessage: {
                        ...common,
                        caption: content.caption,
                        gifPlayback: content.gifPlayback,
                        seconds: content.seconds,
                        width: content.width,
                        height: content.height,
                        metadataUrl: uploaded.metadataUrl
                    }
                }
            case 'audio':
                return {
                    audioMessage: {
                        ...common,
                        seconds: content.seconds,
                        ptt: content.ptt
                    }
                }
            case 'document':
                return {
                    documentMessage: {
                        ...common,
                        caption: content.caption,
                        fileName: content.fileName ?? 'file',
                        title: content.fileName ?? undefined
                    }
                }
            case 'sticker':
                return {
                    stickerMessage: {
                        ...common,
                        width: content.width,
                        height: content.height
                    }
                }
            default:
                throw new Error(`unsupported media type: ${(content as { type: string }).type}`)
        }
    }

    private async uploadMedia(
        content: WaSendMediaMessage,
        mediaBytes: Uint8Array
    ): Promise<{
        readonly url: string
        readonly directPath: string
        readonly mediaKey: Uint8Array
        readonly fileSha256: Uint8Array
        readonly fileEncSha256: Uint8Array
        readonly metadataUrl?: string
    }> {
        const mediaKey = await this.mediaCrypto.generateMediaKey()
        const uploadType =
            content.type === 'video' && content.gifPlayback
                ? 'gif'
                : content.type === 'audio' && content.ptt
                  ? 'ptt'
                  : content.type
        const encrypted = await this.mediaCrypto.encryptBytes(uploadType, mediaKey, mediaBytes)
        const mediaConn = await this.getMediaConn()
        const selectedHost =
            mediaConn.hosts.find((host) => !host.isFallback)?.hostname ?? mediaConn.hosts[0].hostname
        const uploadPath = MEDIA_UPLOAD_PATHS[uploadType]
        const hashToken = bytesToBase64UrlSafe(encrypted.fileEncSha256)
        const uploadUrl = `https://${selectedHost}${uploadPath}/${hashToken}?auth=${encodeURIComponent(mediaConn.auth)}&token=${encodeURIComponent(hashToken)}`

        this.logger.debug('sending media upload request', {
            mediaType: content.type,
            uploadType,
            host: selectedHost
        })
        const uploadResponse = await this.mediaTransfer.uploadStream({
            url: uploadUrl,
            method: 'POST',
            body: encrypted.ciphertextHmac,
            contentLength: encrypted.ciphertextHmac.byteLength,
            contentType: content.mimetype
        })
        const uploadBody = await this.mediaTransfer.readResponseBytes(uploadResponse)
        if (!uploadResponse.ok) {
            throw new Error(`media upload failed with status ${uploadResponse.status}`)
        }

        let parsedBody: {
            readonly url?: string
            readonly direct_path?: string
            readonly metadata_url?: string
        }
        try {
            parsedBody = JSON.parse(TEXT_DECODER.decode(uploadBody)) as {
                readonly url?: string
                readonly direct_path?: string
                readonly metadata_url?: string
            }
        } catch (error) {
            throw new Error(`media upload returned invalid json: ${toError(error).message}`)
        }

        if (!parsedBody.url || !parsedBody.direct_path) {
            throw new Error('media upload response missing url/direct_path')
        }

        return {
            url: parsedBody.url,
            directPath: parsedBody.direct_path,
            mediaKey,
            fileSha256: encrypted.fileSha256,
            fileEncSha256: encrypted.fileEncSha256,
            ...(parsedBody.metadata_url ? { metadataUrl: parsedBody.metadata_url } : {})
        }
    }

    private async getMediaConn(forceRefresh = false): Promise<WaMediaConn> {
        if (
            !forceRefresh &&
            this.mediaConnCache &&
            Date.now() + MEDIA_CONN_CACHE_GRACE_MS < this.mediaConnCache.expiresAtMs
        ) {
            return this.mediaConnCache
        }

        const response = await this.queryWithContext(
            'media_conn.fetch',
            buildMediaConnIq(),
            IQ_TIMEOUT_MS
        )
        const mediaConn = parseMediaConnResponse(response, Date.now())
        this.mediaConnCache = mediaConn
        return mediaConn
    }

    private async handleIncomingNode(node: BinaryNode): Promise<void> {
        this.logger.trace('wa client incoming node', {
            tag: node.tag,
            id: node.attrs.id,
            type: node.attrs.type
        })
        const streamControlResult = parseStreamControlNode(node)
        if (streamControlResult) {
            await this.handleStreamControlResult(streamControlResult)
            return
        }
        if (await this.handleSuccessNode(node)) {
            return
        }
        if (await this.handleInfoBulletinNode(node)) {
            return
        }
        await this.incomingNodeRouter.dispatch(node)
    }

    private async handleSuccessNode(node: BinaryNode): Promise<boolean> {
        if (node.tag !== SUCCESS_NODE_TAG) {
            return false
        }

        const persistAttributes = parseSuccessPersistAttributes(node, (error) => {
            this.logger.warn('invalid companion_enc_static in success node', {
                message: error.message
            })
        })
        this.logger.info('received success node', {
            t: node.attrs.t,
            props: node.attrs.props,
            abprops: node.attrs.abprops,
            location: node.attrs.location,
            hasCompanionEncStatic: persistAttributes.companionEncStatic !== undefined,
            meLid: persistAttributes.meLid,
            meDisplayName: persistAttributes.meDisplayName
        })
        this.emit('success', node)
        if (persistAttributes.lastSuccessTs !== undefined) {
            this.updateClockSkewFromSuccess(persistAttributes.lastSuccessTs)
        }
        await this.authClient.persistSuccessAttributes(persistAttributes)
        this.scheduleMediaConnWarmup()
        return true
    }

    private scheduleMediaConnWarmup(): void {
        if (this.mediaConnWarmupPromise) {
            return
        }
        this.mediaConnWarmupPromise = this.warmupMediaConnAfterSuccess()
            .then(() => {
                this.logger.debug('post-login media_conn warmup completed')
            })
            .catch((error) => {
                this.logger.warn('post-login media_conn warmup failed', {
                    message: toError(error).message
                })
            })
            .finally(() => {
                this.mediaConnWarmupPromise = null
            })
    }

    private async warmupMediaConnAfterSuccess(): Promise<void> {
        const credentials = this.authClient.getCurrentCredentials()
        if (!credentials?.meJid || !this.comms || !this.comms.getCommsState().connected) {
            return
        }
        await this.getMediaConn(true)
    }

    private async handleInfoBulletinNode(node: BinaryNode): Promise<boolean> {
        if (node.tag !== INFO_BULLETIN_NODE_TAG) {
            return false
        }
        const edgeRoutingNode = findNodeChild(node, INFO_BULLETIN_EDGE_ROUTING_TAG)
        if (edgeRoutingNode) {
            await this.handleEdgeRoutingInfoNode(edgeRoutingNode)
        }

        const dirtyNodes = getNodeChildrenByTag(node, INFO_BULLETIN_DIRTY_TAG)
        const dirtyBits: WaDirtyBit[] = []
        for (let index = 0; index < dirtyNodes.length; index += 1) {
            const parsedDirtyBit = parseDirtyBitNode(dirtyNodes[index], this.logger)
            if (parsedDirtyBit) {
                dirtyBits.push(parsedDirtyBit)
            }
        }
        if (dirtyBits.length > 0) {
            await this.handleDirtyBits(dirtyBits)
        }
        return edgeRoutingNode !== undefined || dirtyBits.length > 0
    }

    private async handleEdgeRoutingInfoNode(edgeRoutingNode: BinaryNode): Promise<void> {
        const routingInfoNode = findNodeChild(edgeRoutingNode, INFO_BULLETIN_ROUTING_INFO_TAG)
        if (!routingInfoNode) {
            return
        }
        try {
            const routingInfo = decodeBinaryNodeContent(
                routingInfoNode.content,
                `ib.${INFO_BULLETIN_EDGE_ROUTING_TAG}.${INFO_BULLETIN_ROUTING_INFO_TAG}`
            )
            await this.authClient.persistRoutingInfo(routingInfo)
            this.logger.info('updated routing info from info bulletin', {
                byteLength: routingInfo.byteLength
            })
        } catch (error) {
            this.logger.warn('failed to process routing info from info bulletin', {
                message: toError(error).message
            })
        }
    }

    private async handleDirtyBits(dirtyBits: readonly WaDirtyBit[]): Promise<void> {
        const { supported, unsupported } = splitDirtyBitsBySupport(dirtyBits)

        this.logger.info('handling dirty bits from info bulletin', {
            supported: supported.map((entry) => entry.type).join(','),
            unsupported: unsupported.map((entry) => entry.type).join(',')
        })

        await Promise.all(
            supported.map(async (dirtyBit) => {
                try {
                    await this.handleDirtyBit(dirtyBit)
                } catch (error) {
                    this.logger.warn('failed handling dirty bit', {
                        type: dirtyBit.type,
                        message: toError(error).message
                    })
                }
            })
        )

        await this.clearDirtyBits(unsupported.concat(supported))
    }

    private async handleDirtyBit(dirtyBit: WaDirtyBit): Promise<void> {
        switch (dirtyBit.type) {
            case DIRTY_TYPE_ACCOUNT_SYNC:
                await this.handleAccountSyncDirtyBit(dirtyBit.protocols)
                return
            case DIRTY_TYPE_SYNCD_APP_STATE:
                this.logger.info('received syncd_app_state dirty bit, starting sync')
                try {
                    await this.syncAppState()
                } catch (error) {
                    this.logger.warn('app-state sync failed after dirty bit', {
                        message: toError(error).message
                    })
                }
                return
            case DIRTY_TYPE_GROUPS:
                await this.syncGroupsDirtyBit()
                return
            case DIRTY_TYPE_NEWSLETTER_METADATA:
                await this.syncNewsletterMetadataDirtyBit()
                return
            default:
                this.logger.debug('received unsupported dirty bit', {
                    type: dirtyBit.type
                })
                return
        }
    }

    private async handleAccountSyncDirtyBit(protocols: readonly string[]): Promise<void> {
        const selectedProtocols = resolveAccountSyncProtocols(protocols)
        this.logger.info('received account_sync dirty bit', {
            protocols: selectedProtocols.join(',')
        })
        await Promise.all(
            selectedProtocols.map(async (protocol) => {
                try {
                    await this.runAccountSyncProtocol(protocol)
                } catch (error) {
                    this.logger.warn('account_sync protocol failed', {
                        protocol,
                        message: toError(error).message
                    })
                }
            })
        )
    }

    private async runAccountSyncProtocol(protocol: string): Promise<void> {
        switch (protocol) {
            case DIRTY_PROTOCOL_DEVICES:
                await this.syncAccountDevicesDirtyBit()
                return
            case DIRTY_PROTOCOL_PICTURE:
                await this.syncAccountPictureDirtyBit()
                return
            case DIRTY_PROTOCOL_PRIVACY:
                await this.syncAccountPrivacyDirtyBit()
                return
            case DIRTY_PROTOCOL_BLOCKLIST:
                await this.syncAccountBlocklistDirtyBit()
                return
            case DIRTY_PROTOCOL_NOTICE:
                await this.syncAccountNoticeDirtyBit()
                return
            default:
                this.logger.debug('unsupported account_sync protocol', {
                    protocol
                })
                return
        }
    }

    private async syncAccountDevicesDirtyBit(): Promise<void> {
        const credentials = this.authClient.getCurrentCredentials()
        if (!credentials?.meJid) {
            this.logger.warn('account_sync devices skipped: meJid is missing')
            return
        }

        const response = await this.queryWithContext(
            'account_sync.devices',
            buildAccountDevicesSyncIq(credentials.meJid, await this.generateUsyncSid()),
            IQ_TIMEOUT_MS,
            {
                meJid: credentials.meJid
            }
        )
        assertIqResult(response, 'account_sync.devices')
        this.logger.debug('account_sync devices synchronized', {
            meJid: credentials.meJid
        })
    }

    private async syncAccountPictureDirtyBit(): Promise<void> {
        const credentials = this.authClient.getCurrentCredentials()
        if (!credentials?.meJid) {
            this.logger.warn('account_sync picture skipped: meJid is missing')
            return
        }

        const response = await this.queryWithContext(
            'account_sync.picture',
            buildAccountPictureSyncIq(credentials.meJid),
            IQ_TIMEOUT_MS,
            {
                meJid: credentials.meJid
            }
        )
        assertIqResult(response, 'account_sync.picture')
        this.logger.debug('account_sync picture synchronized', {
            meJid: credentials.meJid
        })
    }

    private async syncAccountPrivacyDirtyBit(): Promise<void> {
        const response = await this.queryWithContext(
            'account_sync.privacy',
            buildAccountPrivacySyncIq(),
            IQ_TIMEOUT_MS
        )
        assertIqResult(response, 'account_sync.privacy')
        this.logger.debug('account_sync privacy synchronized')
    }

    private async syncAccountBlocklistDirtyBit(): Promise<void> {
        const response = await this.queryWithContext(
            'account_sync.blocklist',
            buildAccountBlocklistSyncIq(),
            IQ_TIMEOUT_MS
        )
        assertIqResult(response, 'account_sync.blocklist')
        this.logger.debug('account_sync blocklist synchronized')
    }

    private async syncAccountNoticeDirtyBit(): Promise<void> {
        this.logger.info('account_sync notice protocol received (no GraphQL/MEX job configured)')
    }

    private async syncGroupsDirtyBit(): Promise<void> {
        const response = await this.queryWithContext(
            'dirty.groups',
            buildGroupsDirtySyncIq(),
            IQ_TIMEOUT_MS
        )
        assertIqResult(response, 'groups')
        this.logger.debug('groups dirty sync completed')
    }

    private async syncNewsletterMetadataDirtyBit(): Promise<void> {
        this.logger.info('newsletter_metadata dirty bit received (GraphQL/MEX sync intentionally disabled)')
        await this.queryWithContext(
            'dirty.newsletter_metadata',
            buildNewsletterMetadataSyncIq(),
            IQ_TIMEOUT_MS
        ).catch(() => undefined)
    }

    private async generateUsyncSid(): Promise<string> {
        const seed = await randomBytesAsync(8)
        return Buffer.from(seed).toString('hex')
    }

    private async clearDirtyBits(dirtyBits: readonly WaDirtyBit[]): Promise<void> {
        try {
            await this.queryWithContext(
                'dirty.clear',
                buildClearDirtyBitsIq(dirtyBits),
                IQ_TIMEOUT_MS,
                {
                    count: dirtyBits.length
                }
            )
            this.logger.info('dirty bits cleared', {
                count: dirtyBits.length
            })
        } catch {
            return
        }
    }

    private async handleStreamControlResult(result: WaStreamControlNodeResult): Promise<void> {
        await handleParsedStreamControl(result, {
            logger: this.logger,
            forceLoginDueToStreamError: async (code) => this.forceLoginDueToStreamError(code),
            logoutDueToStreamError: async (reason, shouldRestartBackend) =>
                this.logoutDueToStreamError(reason, shouldRestartBackend),
            disconnectDueToStreamError: async (reason) => this.disconnectDueToStreamError(reason),
            resumeSocketDueToStreamError: async (reason) => this.resumeSocketDueToStreamError(reason)
        })
    }

    private async resumeSocketDueToStreamError(reason: string): Promise<void> {
        const comms = this.comms
        if (!comms) {
            return
        }
        this.logger.info('resuming socket due to stream control node', { reason })
        this.nodeOrchestrator.clearPending(new Error(`socket resume requested by ${reason}`))
        this.mediaConnCache = null
        try {
            await comms.closeSocketAndResume()
        } catch (error) {
            this.logger.warn('failed to resume socket for stream control node', {
                reason,
                message: toError(error).message
            })
        }
    }

    private async forceLoginDueToStreamError(code: number): Promise<void> {
        await this.runStreamControlLifecycle(
            `stream_error_code_${code}`,
            async () => {
                this.logger.warn('received forced login stream error; starting login lifecycle', {
                    code
                })
                await this.disconnect()
                await this.authClient.clearStoredCredentials()
                await this.restartBackendAfterStreamControl(`stream_error_code_${code}`)
            }
        )
    }

    private async disconnectDueToStreamError(reason: string): Promise<void> {
        this.logger.warn('disconnecting due to stream control node', { reason })
        await this.disconnect()
    }

    private async logoutDueToStreamError(
        reason: string,
        shouldRestartBackend: boolean
    ): Promise<void> {
        await this.runStreamControlLifecycle(
            reason,
            async () => {
                this.logger.warn('logging out due to stream control node', {
                    reason,
                    shouldRestartBackend
                })
                await this.disconnect()
                await this.authClient.clearStoredCredentials()
                if (shouldRestartBackend) {
                    await this.restartBackendAfterStreamControl(reason)
                }
            }
        )
    }

    private async ensureSignalSession(
        address: SignalAddress,
        jid: string,
        expectedIdentity?: Uint8Array,
        reasonIdentity = false
    ): Promise<void> {
        if (await this.signalProtocol.hasSession(address)) {
            return
        }
        this.logger.info('signal session missing, fetching remote key bundle', { jid })
        const fetched = await this.signalSessionSync.fetchKeyBundle({
            jid,
            reasonIdentity
        })
        const remoteIdentity = toSerializedPubKey(fetched.bundle.identity)
        if (
            expectedIdentity &&
            !uint8Equal(remoteIdentity, toSerializedPubKey(expectedIdentity))
        ) {
            throw new Error('identity mismatch')
        }
        await this.signalProtocol.establishOutgoingSession(address, fetched.bundle)
        this.logger.info('signal session synchronized', {
            jid,
            regId: fetched.bundle.regId,
            hasOneTimeKey: fetched.bundle.oneTimeKey !== undefined
        })
    }

    private scheduleReconnectAfterPairing(): void {
        this.logger.debug('wa client scheduling reconnect after pairing')
        setTimeout(() => {
            void this.reconnectAsRegisteredAfterPairing().catch((error) => {
                this.handleError(toError(error))
            })
        }, 0)
    }

    private async reconnectAsRegisteredAfterPairing(): Promise<void> {
        if (this.pairingReconnectPromise) {
            this.logger.trace('pairing reconnect already in-flight')
            return this.pairingReconnectPromise
        }
        this.pairingReconnectPromise = this.reconnectAsRegisteredAfterPairingInternal().finally(
            () => {
                this.pairingReconnectPromise = null
            }
        )
        return this.pairingReconnectPromise
    }

    private async reconnectAsRegisteredAfterPairingInternal(): Promise<void> {
        const credentials = this.authClient.getCurrentCredentials()
        if (!credentials?.meJid) {
            this.logger.trace('pairing reconnect skipped: still unregistered')
            return
        }
        const currentComms = this.comms
        if (!currentComms) {
            this.logger.trace('pairing reconnect skipped: no active comms')
            return
        }

        this.logger.info('pairing completed, restarting comms as registered')
        this.keepAlive.stop()
        this.nodeOrchestrator.clearPending(new Error('restarting comms after pairing'))

        this.comms = null
        this.nodeTransport.bindComms(null)
        try {
            await currentComms.stopComms()
        } catch (error) {
            this.logger.warn('failed to stop pre-registration comms', {
                message: toError(error).message
            })
        }
        await this.startCommsWithCredentials(credentials)
    }

    private async startCommsWithCredentials(
        credentials: WaAuthCredentials
    ): Promise<void> {
        this.logger.debug('starting comms with credentials', {
            registered: credentials.meJid !== null && credentials.meJid !== undefined
        })
        const commsConfig = this.authClient.buildCommsConfig(this.options)
        const comms = new WaComms(commsConfig, this.logger)
        this.comms = comms
        this.mediaConnCache = null
        this.nodeTransport.bindComms(comms)

        comms.startComms(async (frame) => {
            try {
                await this.nodeTransport.dispatchIncomingFrame(frame, async (node) =>
                    this.handleIncomingNode(node)
                )
            } catch (error) {
                this.handleError(toError(error))
            }
        })
        await comms.waitForConnection(this.options.connectTimeoutMs)
        this.logger.info('comms connected')
        comms.startHandlingRequests()
        if (credentials.meJid) {
            this.keepAlive.start()
        } else {
            this.keepAlive.stop()
        }

        const serverStaticKey = comms.getServerStaticKey()
        if (!serverStaticKey) {
            this.logger.trace('no server static key available to persist')
        } else {
            await this.authClient.persistServerStaticKey(serverStaticKey)
            this.logger.debug('persisted server static key after comms connect')
        }
        this.startPassiveTasksAfterConnect()
    }

    private startPassiveTasksAfterConnect(): void {
        if (this.passiveTasksPromise) {
            this.logger.trace('passive connect tasks already running')
            return
        }
        this.passiveTasksPromise = this.runPassiveTasksAfterConnect()
            .catch((error) => {
                this.logger.warn('passive connect tasks failed', {
                    message: toError(error).message
                })
            })
            .finally(() => {
                this.passiveTasksPromise = null
            })
    }

    private async runPassiveTasksAfterConnect(): Promise<void> {
        await this.uploadPreKeysIfMissing()

        const credentials = this.authClient.getCurrentCredentials()
        const isRegistered = credentials?.meJid !== null && credentials?.meJid !== undefined
        if (!isRegistered) {
            this.logger.trace('registered passive tasks skipped: session is not registered')
            return
        }

        await this.syncAbProps()
        await this.flushDanglingReceipts()
    }

    private async uploadPreKeysIfMissing(): Promise<void> {
        const serverHasPreKeys = await this.signalStore.getServerHasPreKeys()
        if (serverHasPreKeys) {
            this.logger.trace('prekey upload skipped: server already has prekeys')
            return
        }

        const registrationInfo = await this.signalStore.getRegistrationInfo()
        const signedPreKey = await this.signalStore.getSignedPreKey()
        if (!registrationInfo || !signedPreKey) {
            this.logger.warn('prekey upload skipped: registration info is missing')
            return
        }

        const preKeys = await this.signalStore.getOrGenPreKeys(SIGNAL_UPLOAD_PREKEYS_COUNT, async (keyId) =>
            generatePreKeyPair(this.x25519, keyId)
        )
        if (preKeys.length === 0) {
            throw new Error('no prekey available for upload')
        }

        const lastPreKeyId = preKeys[preKeys.length - 1].keyId
        await this.signalStore.markKeyAsUploaded(lastPreKeyId)
        const uploadNode = buildPreKeyUploadIq(registrationInfo, signedPreKey, preKeys)
        const response = await this.queryWithContext(
            'prekeys.upload',
            uploadNode,
            IQ_TIMEOUT_MS,
            {
                count: preKeys.length,
                lastPreKeyId
            }
        )
        if (response.attrs.type === 'result') {
            await this.signalStore.setServerHasPreKeys(true)
            await this.authClient.persistServerHasPreKeys(true)
            this.logger.info('uploaded prekeys to server', {
                count: preKeys.length,
                lastPreKeyId
            })
            return
        }

        const failure = parsePreKeyUploadFailure(response)
        this.logger.warn('upload prekeys failed', {
            count: preKeys.length,
            errorCode: failure.errorCode,
            errorText: failure.errorText
        })
    }

    private async syncAbProps(): Promise<void> {
        const propsAttrs: Record<string, string> = {
            protocol: ABPROPS_PROTOCOL_VERSION
        }
        if (this.abPropsHash) {
            propsAttrs.hash = this.abPropsHash
        }
        if (this.abPropsRefreshId !== null) {
            propsAttrs.refresh_id = `${this.abPropsRefreshId}`
        }

        const response = await this.queryWithContext(
            'abprops.sync',
            buildIqNode('get', USER_SERVER, ABT_XMLNS, [
                {
                    tag: 'props',
                    attrs: propsAttrs
                }
            ]),
            IQ_TIMEOUT_MS
        )
        assertIqResult(response, 'abprops')
        const propsNode = findNodeChild(response, 'props')
        if (!propsNode) {
            this.logger.debug('abprops response has no props node')
            return
        }

        const nextHash = propsNode.attrs.hash
        if (nextHash && nextHash.length > 0) {
            this.abPropsHash = nextHash
        }
        const nextRefreshIdRaw = propsNode.attrs.refresh_id
        if (nextRefreshIdRaw !== undefined) {
            const nextRefreshId = Number.parseInt(nextRefreshIdRaw, 10)
            if (Number.isSafeInteger(nextRefreshId) && nextRefreshId >= 0) {
                this.abPropsRefreshId = nextRefreshId
            }
        }

        this.logger.info('abprops synchronized', {
            hasHash: this.abPropsHash !== null,
            refreshId: this.abPropsRefreshId
        })
    }

    private async flushDanglingReceipts(): Promise<void> {
        if (this.danglingReceipts.length === 0) {
            return
        }
        const pending = this.danglingReceipts.splice(0)
        this.logger.info('flushing dangling receipts', { count: pending.length })
        for (let index = 0; index < pending.length; index += 1) {
            const node = pending[index]
            try {
                await this.nodeOrchestrator.sendNode(node)
            } catch (error) {
                const normalized = toError(error)
                if (this.shouldQueueDanglingReceipt(node, normalized)) {
                    for (let restoreIndex = index; restoreIndex < pending.length; restoreIndex += 1) {
                        this.enqueueDanglingReceipt(pending[restoreIndex])
                    }
                    this.logger.warn('stopped dangling receipt flush due transient send error', {
                        remaining: pending.length - index,
                        message: normalized.message
                    })
                    return
                }
                this.logger.warn('dropping dangling receipt due non-retryable send error', {
                    id: node.attrs.id,
                    to: node.attrs.to,
                    message: normalized.message
                })
            }
        }
        this.logger.info('dangling receipts flushed')
    }

    private shouldQueueDanglingReceipt(node: BinaryNode, error: Error): boolean {
        if (node.tag !== RECEIPT_NODE_TAG) {
            return false
        }
        const message = error.message.toLowerCase()
        return (
            message.includes('not connected') ||
            message.includes('socket') ||
            message.includes('closed') ||
            message.includes('connection') ||
            message.includes('timeout')
        )
    }

    private enqueueDanglingReceipt(node: BinaryNode): void {
        if (node.tag !== RECEIPT_NODE_TAG) {
            return
        }
        if (this.danglingReceipts.length >= MAX_DANGLING_RECEIPTS) {
            this.danglingReceipts.shift()
        }
        this.danglingReceipts.push(
            node.content === undefined
                ? {
                      tag: node.tag,
                      attrs: { ...node.attrs }
                  }
                : {
                      tag: node.tag,
                      attrs: { ...node.attrs },
                      content: node.content
                  }
        )
    }

    private handleError(error: Error): void {
        this.logger.error('wa client error', { message: error.message })
        this.emit('error', error)
    }

    private updateClockSkewFromSuccess(serverUnixSeconds: number): void {
        const serverMs = serverUnixSeconds * 1000
        const nowMs = Date.now()
        this.clockSkewMs = serverMs - nowMs
        this.logger.debug('updated clock skew from success', {
            serverUnixSeconds,
            clockSkewMs: this.clockSkewMs
        })
    }

    private async runStreamControlLifecycle(
        reason: string,
        action: () => Promise<void>
    ): Promise<void> {
        if (this.streamControlLifecyclePromise) {
            this.logger.debug('stream-control lifecycle already running', { reason })
            return this.streamControlLifecyclePromise
        }
        this.streamControlLifecyclePromise = action().finally(() => {
            this.streamControlLifecyclePromise = null
        })
        return this.streamControlLifecyclePromise
    }

    private async restartBackendAfterStreamControl(reason: string): Promise<void> {
        this.logger.info('restarting backend after stream control', { reason })
        try {
            await this.connect()
        } catch (error) {
            this.logger.warn('failed to restart backend after stream control', {
                reason,
                message: toError(error).message
            })
        }
    }
}
