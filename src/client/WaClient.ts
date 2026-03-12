import { EventEmitter } from 'node:events'

import type { WaAppStateStoreData, WaAppStateSyncResult } from '@appstate/types'
import type { WaAppStateSyncOptions } from '@appstate/types'
import { downloadExternalBlobReference } from '@appstate/utils'
import { WaAppStateSyncClient } from '@appstate/WaAppStateSyncClient'
import type { WaAuthCredentials } from '@auth/types'
import { WaAuthClient } from '@auth/WaAuthClient'
import { WaIncomingNodeCoordinator } from '@client/coordinators/WaIncomingNodeCoordinator'
import { WaMessageDispatchCoordinator } from '@client/coordinators/WaMessageDispatchCoordinator'
import { WaPassiveTasksCoordinator } from '@client/coordinators/WaPassiveTasksCoordinator'
import { WaRetryCoordinator } from '@client/coordinators/WaRetryCoordinator'
import { WaStreamControlCoordinator } from '@client/coordinators/WaStreamControlCoordinator'
import { handleDirtyBits, parseDirtyBits } from '@client/dirty'
import { buildMediaMessageContent, getMediaConn as getClientMediaConn } from '@client/messages'
import type {
    WaClientEventMap,
    WaClientOptions,
    WaIncomingMessageEvent,
    WaIncomingProtocolMessageEvent,
    WaIncomingUnhandledStanzaEvent,
    WaSignalMessagePublishInput,
    WaSendMessageOptions
} from '@client/types'
import { ConsoleLogger } from '@infra/log/ConsoleLogger'
import type { Logger } from '@infra/log/types'
import type { WaMediaConn } from '@media/types'
import { WaMediaTransferClient } from '@media/WaMediaTransferClient'
import { handleIncomingMessageAck } from '@message/incoming'
import type {
    WaEncryptedMessageInput,
    WaMessagePublishOptions,
    WaMessagePublishResult,
    WaSendMessageContent,
    WaSendReceiptInput
} from '@message/types'
import { WaMessageClient } from '@message/WaMessageClient'
import { proto, type Proto } from '@proto'
import { getWaCompanionPlatformId, WA_DEFAULTS, WA_MESSAGE_TAGS } from '@protocol/constants'
import type { WaRetryDecryptFailureContext } from '@retry/types'
import { SignalDeviceSyncApi } from '@signal/api/SignalDeviceSyncApi'
import { SignalSessionSyncApi } from '@signal/api/SignalSessionSyncApi'
import { SenderKeyManager } from '@signal/group/SenderKeyManager'
import { SignalProtocol } from '@signal/session/SignalProtocol'
import type { WaAppStateStore } from '@store/contracts/appstate.store'
import type { WaRetryStore } from '@store/contracts/retry.store'
import type { WaSignalStore } from '@store/contracts/signal.store'
import { WaKeepAlive } from '@transport/keepalive/WaKeepAlive'
import { queryWithContext as queryNodeWithContext } from '@transport/node/query'
import { WaNodeOrchestrator } from '@transport/node/WaNodeOrchestrator'
import { WaNodeTransport } from '@transport/node/WaNodeTransport'
import type { BinaryNode } from '@transport/types'
import { WaComms } from '@transport/WaComms'
import { toError } from '@util/primitives'
import { getRuntimeOsDisplayName } from '@util/runtime'

export class WaClient extends EventEmitter {
    private readonly options: Readonly<WaClientOptions>
    private readonly logger: Logger
    private readonly signalStore: WaSignalStore
    private readonly appStateStore: WaAppStateStore
    private readonly retryStore: WaRetryStore
    private readonly authClient: WaAuthClient
    private readonly nodeOrchestrator: WaNodeOrchestrator
    private readonly keepAlive: WaKeepAlive
    private readonly nodeTransport: WaNodeTransport
    private readonly appStateSync: WaAppStateSyncClient
    private readonly incomingNode: WaIncomingNodeCoordinator
    private readonly passiveTasks: WaPassiveTasksCoordinator
    private readonly streamControl: WaStreamControlCoordinator
    private readonly mediaTransfer: WaMediaTransferClient
    private readonly messageDispatch: WaMessageDispatchCoordinator
    private readonly messageClient: WaMessageClient
    private readonly senderKeyManager: SenderKeyManager
    private readonly signalProtocol: SignalProtocol
    private readonly signalDeviceSync: SignalDeviceSyncApi
    private readonly signalSessionSync: SignalSessionSyncApi
    private readonly retryCoordinator: WaRetryCoordinator
    private clockSkewMs: number | null
    private mediaConnCache: WaMediaConn | null
    private comms: WaComms | null
    private pairingReconnectPromise: Promise<void> | null
    private readonly danglingReceipts: BinaryNode[]

    public constructor(options: WaClientOptions, logger: Logger = new ConsoleLogger('info')) {
        super()
        const deviceBrowser = options.deviceBrowser ?? WA_DEFAULTS.DEVICE_BROWSER
        const sessionId = options.sessionId.trim()
        if (sessionId.length === 0) {
            throw new Error('sessionId must be a non-empty string')
        }
        const sessionStore = options.store.session(sessionId)
        this.options = Object.freeze({
            ...options,
            sessionId,
            deviceBrowser,
            deviceOsDisplayName: options.deviceOsDisplayName ?? getRuntimeOsDisplayName(),
            devicePlatform: options.devicePlatform ?? getWaCompanionPlatformId(deviceBrowser),
            urls: options.urls ?? options.chatSocketUrls ?? WA_DEFAULTS.CHAT_SOCKET_URLS,
            iqTimeoutMs: options.iqTimeoutMs ?? WA_DEFAULTS.IQ_TIMEOUT_MS,
            nodeQueryTimeoutMs: options.nodeQueryTimeoutMs ?? WA_DEFAULTS.NODE_QUERY_TIMEOUT_MS,
            keepAliveIntervalMs:
                options.keepAliveIntervalMs ?? WA_DEFAULTS.HEALTH_CHECK_INTERVAL_MS,
            deadSocketTimeoutMs: options.deadSocketTimeoutMs ?? WA_DEFAULTS.DEAD_SOCKET_TIMEOUT_MS,
            mediaTimeoutMs: options.mediaTimeoutMs ?? WA_DEFAULTS.MEDIA_TIMEOUT_MS,
            appStateSyncTimeoutMs:
                options.appStateSyncTimeoutMs ?? WA_DEFAULTS.APP_STATE_SYNC_TIMEOUT_MS,
            signalFetchKeyBundlesTimeoutMs:
                options.signalFetchKeyBundlesTimeoutMs ??
                WA_DEFAULTS.SIGNAL_FETCH_KEY_BUNDLES_TIMEOUT_MS,
            messageAckTimeoutMs: options.messageAckTimeoutMs ?? WA_DEFAULTS.MESSAGE_ACK_TIMEOUT_MS,
            messageMaxAttempts: options.messageMaxAttempts ?? WA_DEFAULTS.MESSAGE_MAX_ATTEMPTS,
            messageRetryDelayMs: options.messageRetryDelayMs ?? WA_DEFAULTS.MESSAGE_RETRY_DELAY_MS
        })
        this.logger = logger
        this.signalStore = sessionStore.signal
        this.appStateStore = sessionStore.appState
        this.retryStore = sessionStore.retry
        this.comms = null
        this.danglingReceipts = []
        this.clockSkewMs = null
        this.mediaConnCache = null
        this.pairingReconnectPromise = null

        this.nodeTransport = new WaNodeTransport(this.logger)
        this.bindNodeTransportEvents()
        this.nodeOrchestrator = new WaNodeOrchestrator({
            sendNode: async (node) => this.nodeTransport.sendNode(node),
            logger: this.logger,
            defaultTimeoutMs: this.options.nodeQueryTimeoutMs,
            hostDomain: WA_DEFAULTS.HOST_DOMAIN
        })
        this.keepAlive = new WaKeepAlive({
            logger: this.logger,
            nodeOrchestrator: this.nodeOrchestrator,
            getComms: () => this.comms,
            intervalMs: this.options.keepAliveIntervalMs,
            timeoutMs: this.options.deadSocketTimeoutMs,
            hostDomain: WA_DEFAULTS.HOST_DOMAIN
        })

        this.mediaTransfer = new WaMediaTransferClient({
            logger: this.logger,
            defaultTimeoutMs: this.options.mediaTimeoutMs
        })
        const sendNode = async (node: BinaryNode) => this.sendNode(node)
        const query = async (node: BinaryNode, timeoutMs?: number) => this.query(node, timeoutMs)
        const queryWithContext = async (
            context: string,
            node: BinaryNode,
            timeoutMs?: number,
            contextData?: Readonly<Record<string, unknown>>
        ) => this.queryWithContext(context, node, timeoutMs, contextData)
        this.messageClient = new WaMessageClient({
            logger: this.logger,
            sendNode,
            query,
            defaultAckTimeoutMs: this.options.messageAckTimeoutMs,
            defaultMaxAttempts: this.options.messageMaxAttempts,
            defaultRetryDelayMs: this.options.messageRetryDelayMs
        })
        const mediaMessageOptions = {
            logger: this.logger,
            mediaTransfer: this.mediaTransfer,
            iqTimeoutMs: this.options.iqTimeoutMs,
            queryWithContext,
            getMediaConnCache: () => this.mediaConnCache,
            setMediaConnCache: (mediaConn: WaMediaConn | null) => {
                this.mediaConnCache = mediaConn
            }
        }
        this.senderKeyManager = new SenderKeyManager(sessionStore.senderKey)

        this.signalProtocol = new SignalProtocol(sessionStore.signal)
        this.signalDeviceSync = new SignalDeviceSyncApi({
            logger: this.logger,
            query,
            defaultTimeoutMs: this.options.signalFetchKeyBundlesTimeoutMs
        })
        this.signalSessionSync = new SignalSessionSyncApi({
            logger: this.logger,
            query,
            defaultTimeoutMs: this.options.signalFetchKeyBundlesTimeoutMs
        })
        this.authClient = new WaAuthClient(
            {
                deviceBrowser: this.options.deviceBrowser,
                deviceOsDisplayName: this.options.deviceOsDisplayName,
                devicePlatform: this.options.devicePlatform
            },
            {
                logger: this.logger,
                authStore: sessionStore.auth,
                signalStore: sessionStore.signal,
                socket: {
                    sendNode,
                    query
                },
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
        const getCurrentCredentials = () => this.authClient.getCurrentCredentials()
        this.messageDispatch = new WaMessageDispatchCoordinator({
            logger: this.logger,
            messageClient: this.messageClient,
            retryStore: this.retryStore,
            buildMessageContent: async (content) =>
                buildMediaMessageContent(mediaMessageOptions, content),
            senderKeyManager: this.senderKeyManager,
            signalProtocol: this.signalProtocol,
            signalDeviceSync: this.signalDeviceSync,
            signalSessionSync: this.signalSessionSync,
            getCurrentMeJid: () => getCurrentCredentials()?.meJid,
            getCurrentMeLid: () => getCurrentCredentials()?.meLid,
            getCurrentSignedIdentity: () => getCurrentCredentials()?.signedIdentity
        })
        this.retryCoordinator = new WaRetryCoordinator({
            logger: this.logger,
            retryStore: this.retryStore,
            signalStore: this.signalStore,
            signalProtocol: this.signalProtocol,
            signalDeviceSync: this.signalDeviceSync,
            messageClient: this.messageClient,
            sendNode,
            tryResolvePendingNode: (node) => this.nodeOrchestrator.tryResolvePending(node),
            getCurrentMeJid: () => getCurrentCredentials()?.meJid,
            getCurrentMeLid: () => getCurrentCredentials()?.meLid,
            getCurrentSignedIdentity: () => getCurrentCredentials()?.signedIdentity
        })
        const incomingMessageAckOptions = {
            logger: this.logger,
            sendNode,
            getMeJid: () => getCurrentCredentials()?.meJid,
            signalProtocol: this.signalProtocol,
            senderKeyManager: this.senderKeyManager,
            onDecryptFailure: (context: WaRetryDecryptFailureContext, error: unknown) =>
                this.retryCoordinator.onDecryptFailure(context, error),
            emitIncomingMessage: (event: WaIncomingMessageEvent) => {
                void this.handleIncomingMessageEvent(event)
            },
            emitUnhandledStanza: (event: WaIncomingUnhandledStanzaEvent) =>
                this.emit('incoming_unhandled_stanza', event)
        } as const
        this.appStateSync = new WaAppStateSyncClient({
            logger: this.logger,
            query,
            defaultTimeoutMs: this.options.appStateSyncTimeoutMs,
            store: this.appStateStore
        })
        const handleClientDirtyBits = async (dirtyBits: Parameters<typeof handleDirtyBits>[1]) =>
            handleDirtyBits(
                {
                    logger: this.logger,
                    queryWithContext,
                    getCurrentCredentials,
                    syncAppState: async () => {
                        await this.syncAppState()
                    }
                },
                dirtyBits
            )
        this.streamControl = new WaStreamControlCoordinator({
            logger: this.logger,
            getComms: () => this.comms,
            clearPendingQueries: (error) => this.nodeOrchestrator.clearPending(error),
            clearMediaConnCache: () => this.clearMediaConnCache(),
            disconnect: async () => this.disconnect(),
            clearStoredCredentials: async () => this.clearStoredState(),
            connect: async () => this.connect()
        })
        this.incomingNode = new WaIncomingNodeCoordinator({
            logger: this.logger,
            runtime: {
                handleStreamControlResult: async (result) =>
                    this.streamControl.handleStreamControlResult(result),
                persistSuccessAttributes: async (attributes) =>
                    this.authClient.persistSuccessAttributes(attributes),
                emitSuccessNode: (node) => this.emit('success', node),
                updateClockSkewFromSuccess: (serverUnixSeconds) =>
                    this.updateClockSkewFromSuccess(serverUnixSeconds),
                shouldWarmupMediaConn: () => {
                    const credentials = getCurrentCredentials()
                    return !!(
                        credentials?.meJid &&
                        this.comms &&
                        this.comms.getCommsState().connected
                    )
                },
                warmupMediaConn: async () => {
                    await getClientMediaConn(mediaMessageOptions, true)
                },
                persistRoutingInfo: async (routingInfo) =>
                    this.authClient.persistRoutingInfo(routingInfo),
                tryResolvePendingNode: (node) => this.nodeOrchestrator.tryResolvePending(node),
                handleGenericIncomingNode: async (node) =>
                    this.nodeOrchestrator.handleIncomingNode(node),
                handleIncomingIqSetNode: async (node) => this.authClient.handleIncomingIqSet(node),
                handleLinkCodeNotificationNode: async (node) =>
                    this.authClient.handleLinkCodeNotification(node),
                handleCompanionRegRefreshNotificationNode: async (node) =>
                    this.authClient.handleCompanionRegRefreshNotification(node),
                handleIncomingMessageNode: async (node) =>
                    handleIncomingMessageAck(node, incomingMessageAckOptions),
                sendNode,
                handleIncomingRetryReceipt: async (node) =>
                    this.retryCoordinator.handleIncomingRetryReceipt(node),
                trackOutboundReceipt: async (node) =>
                    this.retryCoordinator.trackOutboundReceipt(node),
                emitIncomingReceipt: (event) => this.emit('incoming_receipt', event),
                emitIncomingPresence: (event) => this.emit('incoming_presence', event),
                emitIncomingChatstate: (event) => this.emit('incoming_chatstate', event),
                emitIncomingCall: (event) => this.emit('incoming_call', event),
                emitIncomingFailure: (event) => this.emit('incoming_failure', event),
                emitIncomingErrorStanza: (event) => this.emit('incoming_error_stanza', event),
                emitIncomingNotification: (event) => this.emit('incoming_notification', event),
                emitUnhandledIncomingNode: (event) => this.emit('incoming_unhandled_stanza', event),
                disconnect: async () => this.disconnect(),
                clearStoredCredentials: async () => this.clearStoredState()
            },
            dirtySync: {
                parseDirtyBits: (nodes) => parseDirtyBits(nodes, this.logger),
                handleDirtyBits: async (dirtyBits) => handleClientDirtyBits(dirtyBits)
            }
        })
        this.passiveTasks = new WaPassiveTasksCoordinator({
            logger: this.logger,
            signalStore: this.signalStore,
            runtime: {
                queryWithContext,
                getCurrentCredentials,
                persistServerHasPreKeys: async (serverHasPreKeys) =>
                    this.authClient.persistServerHasPreKeys(serverHasPreKeys),
                sendNodeDirect: async (node) => this.nodeOrchestrator.sendNode(node),
                takeDanglingReceipts: () => this.danglingReceipts.splice(0),
                requeueDanglingReceipt: (node) => this.enqueueDanglingReceipt(node),
                shouldQueueDanglingReceipt: (node, error) =>
                    this.shouldQueueDanglingReceipt(node, error)
            }
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

    public async query(
        node: BinaryNode,
        timeoutMs: number = this.options.iqTimeoutMs ?? WA_DEFAULTS.IQ_TIMEOUT_MS
    ): Promise<BinaryNode> {
        if (!this.comms || !this.comms.getCommsState().connected) {
            throw new Error('client is not connected')
        }
        this.logger.debug('wa client query', { tag: node.tag, id: node.attrs.id, timeoutMs })
        return this.nodeOrchestrator.query(node, timeoutMs)
    }

    private bindNodeTransportEvents(): void {
        this.nodeTransport.on('frame_in', (frame) => this.emit('frame_in', frame))
        this.nodeTransport.on('frame_out', (frame) => this.emit('frame_out', frame))
        this.nodeTransport.on('node_in', (node, frame) => this.emit('node_in', node, frame))
        this.nodeTransport.on('node_out', (node, frame) => this.emit('node_out', node, frame))
        this.nodeTransport.on('decode_error', (error, frame) => {
            this.emit('decode_error', error, frame)
            this.handleError(error)
        })
    }

    private async handleIncomingMessageEvent(event: WaIncomingMessageEvent): Promise<void> {
        this.emit('incoming_message', event)
        const protocolMessage = event.message?.protocolMessage
        if (!protocolMessage) {
            return
        }

        const protocolEvent: WaIncomingProtocolMessageEvent = {
            ...event,
            protocolMessage
        }
        this.emit('incoming_protocol_message', protocolEvent)

        const protocolType = protocolMessage.type
        if (protocolType === null || protocolType === undefined) {
            this.logger.debug('incoming protocol message without type', {
                id: event.id,
                from: event.from
            })
            return
        }

        if (protocolType === proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE) {
            const share = protocolMessage.appStateSyncKeyShare
            if (!share) {
                this.logger.warn('incoming app-state key share protocol message without payload', {
                    id: event.id,
                    from: event.from
                })
                return
            }

            try {
                const imported = await this.importAppStateSyncKeyShare(share)
                this.logger.info('imported app-state sync key share from protocol message', {
                    id: event.id,
                    from: event.from,
                    imported
                })
            } catch (error) {
                this.logger.warn('failed to import app-state sync key share from protocol message', {
                    id: event.id,
                    from: event.from,
                    message: toError(error).message
                })
            }
            return
        }

        if (
            protocolType === proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION ||
            protocolType === proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST ||
            protocolType === proto.Message.ProtocolMessage.Type.APP_STATE_FATAL_EXCEPTION_NOTIFICATION ||
            protocolType === proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE ||
            protocolType ===
                proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE
        ) {
            this.logger.info('incoming sync-related protocol message', {
                id: event.id,
                from: event.from,
                protocolType
            })
            return
        }

        this.logger.debug('incoming protocol message received', {
            id: event.id,
            from: event.from,
            protocolType
        })
    }

    private async queryWithContext(
        context: string,
        node: BinaryNode,
        timeoutMs: number = this.options.iqTimeoutMs ?? WA_DEFAULTS.IQ_TIMEOUT_MS,
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

    private async handleIncomingFrame(frame: Uint8Array): Promise<void> {
        try {
            await this.nodeTransport.dispatchIncomingFrame(frame, async (node) =>
                this.incomingNode.handleIncomingNode(node)
            )
        } catch (error) {
            this.handleError(toError(error))
        }
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
                this.logger.warn(
                    'connect failed with routing info, retrying without routing info',
                    {
                        message: toError(error).message
                    }
                )
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
        this.clearCommsBinding()
        try {
            await currentComms.stopComms()
        } catch (error) {
            this.logger.warn('failed to stop pre-registration comms', {
                message: toError(error).message
            })
        }
        await this.startCommsWithCredentials(credentials)
    }

    public async disconnect(): Promise<void> {
        this.logger.info('wa client disconnect start')
        this.keepAlive.stop()
        await this.authClient.clearTransientState()
        this.nodeOrchestrator.clearPending(new Error('client disconnected'))
        this.clockSkewMs = null
        this.clearMediaConnCache()
        this.passiveTasks.resetInFlightState()

        const comms = this.comms
        this.clearCommsBinding()
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
        return this.messageDispatch.publishMessageNode(node, options)
    }

    public async publishEncryptedMessage(
        input: WaEncryptedMessageInput,
        options: WaMessagePublishOptions = {}
    ): Promise<WaMessagePublishResult> {
        return this.messageDispatch.publishEncryptedMessage(input, options)
    }

    public async publishSignalMessage(
        input: WaSignalMessagePublishInput,
        options: WaMessagePublishOptions = {}
    ): Promise<WaMessagePublishResult> {
        return this.messageDispatch.publishSignalMessage(input, options)
    }

    public async sendMessage(
        to: string,
        content: WaSendMessageContent,
        options: WaSendMessageOptions = {}
    ): Promise<WaMessagePublishResult> {
        return this.messageDispatch.sendMessage(to, content, options)
    }

    public async syncSignalSession(jid: string, reasonIdentity = false): Promise<void> {
        await this.messageDispatch.syncSignalSession(jid, reasonIdentity)
    }

    public async sendReceipt(input: WaSendReceiptInput): Promise<void> {
        await this.messageDispatch.sendReceipt(input)
    }

    public async exportAppState(): Promise<WaAppStateStoreData> {
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

    private async startCommsWithCredentials(credentials: WaAuthCredentials): Promise<void> {
        this.logger.debug('starting comms with credentials', {
            registered: credentials.meJid !== null && credentials.meJid !== undefined
        })
        const commsConfig = this.authClient.buildCommsConfig(this.options)
        const comms = new WaComms(commsConfig, this.logger)
        this.comms = comms
        this.clearMediaConnCache()
        this.bindComms(comms)

        comms.startComms(async (frame) => this.handleIncomingFrame(frame))
        await comms.waitForConnection(commsConfig.connectTimeoutMs)
        this.logger.info('comms connected')
        comms.startHandlingRequests()
        this.syncKeepAlive(Boolean(credentials.meJid))

        const serverStaticKey = comms.getServerStaticKey()
        if (!serverStaticKey) {
            this.logger.trace('no server static key available to persist')
        } else {
            await this.authClient.persistServerStaticKey(serverStaticKey)
            this.logger.debug('persisted server static key after comms connect')
        }
        this.passiveTasks.startPassiveTasksAfterConnect()
    }

    private shouldQueueDanglingReceipt(node: BinaryNode, error: Error): boolean {
        if (node.tag !== WA_MESSAGE_TAGS.RECEIPT) {
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
        if (node.tag !== WA_MESSAGE_TAGS.RECEIPT) {
            return
        }
        if (this.danglingReceipts.length >= WA_DEFAULTS.MAX_DANGLING_RECEIPTS) {
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

    private async clearStoredState(): Promise<void> {
        await this.authClient.clearStoredCredentials()
        await this.appStateStore.clear()
        await this.retryStore.clear()
    }

    private handleError(error: Error): void {
        this.logger.error('wa client error', { message: error.message })
        this.emit('error', error)
    }

    private clearMediaConnCache(): void {
        this.mediaConnCache = null
    }

    private bindComms(comms: WaComms | null): void {
        this.nodeTransport.bindComms(comms)
    }

    private clearCommsBinding(): void {
        this.comms = null
        this.bindComms(null)
    }

    private syncKeepAlive(registered: boolean): void {
        if (registered) {
            this.keepAlive.start()
            return
        }
        this.keepAlive.stop()
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
}
