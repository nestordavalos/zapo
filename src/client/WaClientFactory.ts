import { WaAppStateSyncClient } from '@appstate/WaAppStateSyncClient'
import { WaAuthClient } from '@auth/WaAuthClient'
import { WaIncomingNodeCoordinator } from '@client/coordinators/WaIncomingNodeCoordinator'
import { WaMessageDispatchCoordinator } from '@client/coordinators/WaMessageDispatchCoordinator'
import { WaPassiveTasksCoordinator } from '@client/coordinators/WaPassiveTasksCoordinator'
import { WaRetryCoordinator } from '@client/coordinators/WaRetryCoordinator'
import {
    createStreamControlHandler,
    type WaStreamControlHandler
} from '@client/coordinators/WaStreamControlCoordinator'
import { handleDirtyBits, parseDirtyBits } from '@client/dirty'
import { buildMediaMessageContent, getMediaConn as getClientMediaConn } from '@client/messages'
import type {
    WaClientEventMap,
    WaClientOptions,
    WaIncomingMessageEvent,
    WaIncomingUnhandledStanzaEvent
} from '@client/types'
import type { Logger } from '@infra/log/types'
import type { WaMediaConn } from '@media/types'
import { WaMediaTransferClient } from '@media/WaMediaTransferClient'
import { handleIncomingMessageAck } from '@message/incoming'
import { WaMessageClient } from '@message/WaMessageClient'
import { getWaCompanionPlatformId, WA_DEFAULTS } from '@protocol/constants'
import type { WaRetryDecryptFailureContext } from '@retry/types'
import { SignalDeviceSyncApi } from '@signal/api/SignalDeviceSyncApi'
import { SignalSessionSyncApi } from '@signal/api/SignalSessionSyncApi'
import { SenderKeyManager } from '@signal/group/SenderKeyManager'
import { SignalProtocol } from '@signal/session/SignalProtocol'
import { WaKeepAlive } from '@transport/keepalive/WaKeepAlive'
import { WaNodeOrchestrator } from '@transport/node/WaNodeOrchestrator'
import { WaNodeTransport } from '@transport/node/WaNodeTransport'
import type { BinaryNode } from '@transport/types'
import type { WaComms } from '@transport/WaComms'
import { toError } from '@util/primitives'
import { getRuntimeOsDisplayName } from '@util/runtime'

type WaSessionStore = ReturnType<WaClientOptions['store']['session']>

export type WaMediaMessageBuildOptions = Parameters<typeof buildMediaMessageContent>[0]

export interface WaClientBase {
    readonly options: Readonly<WaClientOptions>
    readonly logger: Logger
    readonly sessionStore: WaSessionStore
}

export interface WaClientDependencies {
    readonly nodeTransport: WaNodeTransport
    readonly nodeOrchestrator: WaNodeOrchestrator
    readonly keepAlive: WaKeepAlive
    readonly mediaTransfer: WaMediaTransferClient
    readonly mediaMessageBuildOptions: WaMediaMessageBuildOptions
    readonly messageClient: WaMessageClient
    readonly senderKeyManager: SenderKeyManager
    readonly signalProtocol: SignalProtocol
    readonly signalDeviceSync: SignalDeviceSyncApi
    readonly signalSessionSync: SignalSessionSyncApi
    readonly authClient: WaAuthClient
    readonly messageDispatch: WaMessageDispatchCoordinator
    readonly retryCoordinator: WaRetryCoordinator
    readonly appStateSync: WaAppStateSyncClient
    readonly streamControl: WaStreamControlHandler
    readonly incomingNode: WaIncomingNodeCoordinator
    readonly passiveTasks: WaPassiveTasksCoordinator
}

export interface WaClientDependencyHost {
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>
    readonly queryWithContext: (
        context: string,
        node: BinaryNode,
        timeoutMs?: number,
        contextData?: Readonly<Record<string, unknown>>
    ) => Promise<BinaryNode>
    readonly syncAppState: () => Promise<void>
    readonly emitEvent: <K extends keyof WaClientEventMap>(
        event: K,
        ...args: Parameters<WaClientEventMap[K]>
    ) => void
    readonly handleIncomingMessageEvent: (event: WaIncomingMessageEvent) => Promise<void>
    readonly handleError: (error: Error) => void
    readonly scheduleReconnectAfterPairing: () => void
    readonly updateClockSkewFromSuccess: (serverUnixSeconds: number) => void
    readonly getComms: () => WaComms | null
    readonly getMediaConnCache: () => WaMediaConn | null
    readonly setMediaConnCache: (mediaConn: WaMediaConn | null) => void
    readonly disconnect: () => Promise<void>
    readonly clearStoredState: () => Promise<void>
    readonly connect: () => Promise<void>
    readonly shouldQueueDanglingReceipt: (node: BinaryNode, error: Error) => boolean
    readonly enqueueDanglingReceipt: (node: BinaryNode) => void
    readonly takeDanglingReceipts: () => BinaryNode[]
}

export function resolveWaClientBase(options: WaClientOptions, logger: Logger): WaClientBase {
    const deviceBrowser = options.deviceBrowser ?? WA_DEFAULTS.DEVICE_BROWSER
    const sessionId = options.sessionId.trim()
    if (sessionId.length === 0) {
        throw new Error('sessionId must be a non-empty string')
    }

    const sessionStore = options.store.session(sessionId)
    const normalizedOptions = Object.freeze({
        ...options,
        sessionId,
        deviceBrowser,
        deviceOsDisplayName: options.deviceOsDisplayName ?? getRuntimeOsDisplayName(),
        devicePlatform: options.devicePlatform ?? getWaCompanionPlatformId(deviceBrowser),
        urls: options.urls ?? options.chatSocketUrls ?? WA_DEFAULTS.CHAT_SOCKET_URLS,
        iqTimeoutMs: options.iqTimeoutMs ?? WA_DEFAULTS.IQ_TIMEOUT_MS,
        nodeQueryTimeoutMs: options.nodeQueryTimeoutMs ?? WA_DEFAULTS.NODE_QUERY_TIMEOUT_MS,
        keepAliveIntervalMs: options.keepAliveIntervalMs ?? WA_DEFAULTS.HEALTH_CHECK_INTERVAL_MS,
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

    return {
        options: normalizedOptions,
        logger,
        sessionStore
    }
}

export function buildWaClientDependencies(input: {
    readonly base: WaClientBase
    readonly host: WaClientDependencyHost
}): WaClientDependencies {
    const { base, host } = input
    const { options, logger, sessionStore } = base

    const nodeTransport = new WaNodeTransport(logger)
    const nodeOrchestrator = new WaNodeOrchestrator({
        sendNode: async (node) => nodeTransport.sendNode(node),
        logger,
        defaultTimeoutMs: options.nodeQueryTimeoutMs,
        hostDomain: WA_DEFAULTS.HOST_DOMAIN
    })
    const keepAlive = new WaKeepAlive({
        logger,
        nodeOrchestrator,
        getComms: host.getComms,
        intervalMs: options.keepAliveIntervalMs,
        timeoutMs: options.deadSocketTimeoutMs,
        hostDomain: WA_DEFAULTS.HOST_DOMAIN
    })

    const mediaTransfer = new WaMediaTransferClient({
        logger,
        defaultTimeoutMs: options.mediaTimeoutMs
    })
    const mediaMessageBuildOptions: WaMediaMessageBuildOptions = {
        logger,
        mediaTransfer,
        iqTimeoutMs: options.iqTimeoutMs,
        queryWithContext: host.queryWithContext,
        getMediaConnCache: host.getMediaConnCache,
        setMediaConnCache: host.setMediaConnCache
    }

    const messageClient = new WaMessageClient({
        logger,
        sendNode: host.sendNode,
        query: host.query,
        defaultAckTimeoutMs: options.messageAckTimeoutMs,
        defaultMaxAttempts: options.messageMaxAttempts,
        defaultRetryDelayMs: options.messageRetryDelayMs
    })
    const senderKeyManager = new SenderKeyManager(sessionStore.senderKey)
    const signalProtocol = new SignalProtocol(sessionStore.signal, logger)
    const signalDeviceSync = new SignalDeviceSyncApi({
        logger,
        query: host.query,
        defaultTimeoutMs: options.signalFetchKeyBundlesTimeoutMs
    })
    const signalSessionSync = new SignalSessionSyncApi({
        logger,
        query: host.query,
        defaultTimeoutMs: options.signalFetchKeyBundlesTimeoutMs
    })
    const authClient = new WaAuthClient(
        {
            deviceBrowser: options.deviceBrowser,
            deviceOsDisplayName: options.deviceOsDisplayName,
            devicePlatform: options.devicePlatform
        },
        {
            logger,
            authStore: sessionStore.auth,
            signalStore: sessionStore.signal,
            socket: {
                sendNode: host.sendNode,
                query: host.query
            },
            callbacks: {
                onQr: (qr, ttlMs) => host.emitEvent('qr', qr, ttlMs),
                onPairingCode: (code) => host.emitEvent('pairing_code', code),
                onPairingRefresh: (forceManual) => host.emitEvent('pairing_refresh', forceManual),
                onPaired: (credentials) => {
                    host.emitEvent('paired', credentials)
                    host.scheduleReconnectAfterPairing()
                },
                onError: (error) => host.handleError(error)
            }
        }
    )
    const messageDispatch = new WaMessageDispatchCoordinator({
        logger,
        messageClient,
        retryStore: sessionStore.retry,
        buildMessageContent: async (content) =>
            buildMediaMessageContent(mediaMessageBuildOptions, content),
        senderKeyManager,
        signalProtocol,
        signalDeviceSync,
        signalSessionSync,
        getCurrentMeJid: () => authClient.getCurrentCredentials()?.meJid,
        getCurrentMeLid: () => authClient.getCurrentCredentials()?.meLid,
        getCurrentSignedIdentity: () => authClient.getCurrentCredentials()?.signedIdentity
    })
    const retryCoordinator = new WaRetryCoordinator({
        logger,
        retryStore: sessionStore.retry,
        signalStore: sessionStore.signal,
        signalProtocol,
        signalDeviceSync,
        messageClient,
        sendNode: host.sendNode,
        tryResolvePendingNode: (node) => nodeOrchestrator.tryResolvePending(node),
        getCurrentMeJid: () => authClient.getCurrentCredentials()?.meJid,
        getCurrentMeLid: () => authClient.getCurrentCredentials()?.meLid,
        getCurrentSignedIdentity: () => authClient.getCurrentCredentials()?.signedIdentity
    })
    const appStateSync = new WaAppStateSyncClient({
        logger,
        query: host.query,
        defaultTimeoutMs: options.appStateSyncTimeoutMs,
        store: sessionStore.appState
    })
    const streamControl = createStreamControlHandler({
        logger,
        getComms: host.getComms,
        clearPendingQueries: (error) => nodeOrchestrator.clearPending(error),
        clearMediaConnCache: () => host.setMediaConnCache(null),
        disconnect: host.disconnect,
        clearStoredCredentials: host.clearStoredState,
        connect: host.connect
    })
    const incomingMessageAckOptions = {
        logger,
        sendNode: host.sendNode,
        getMeJid: () => authClient.getCurrentCredentials()?.meJid,
        signalProtocol,
        senderKeyManager,
        onDecryptFailure: (context: WaRetryDecryptFailureContext, error: unknown) =>
            retryCoordinator.onDecryptFailure(context, error),
        emitIncomingMessage: (event: WaIncomingMessageEvent) => {
            void host
                .handleIncomingMessageEvent(event)
                .catch((err) => host.handleError(toError(err)))
        },
        emitUnhandledStanza: (event: WaIncomingUnhandledStanzaEvent) =>
            host.emitEvent('incoming_unhandled_stanza', event)
    } as const
    const handleClientDirtyBits = async (dirtyBits: Parameters<typeof handleDirtyBits>[1]) =>
        handleDirtyBits(
            {
                logger,
                queryWithContext: host.queryWithContext,
                getCurrentCredentials: () => authClient.getCurrentCredentials(),
                syncAppState: host.syncAppState
            },
            dirtyBits
        )
    const incomingNode = new WaIncomingNodeCoordinator({
        logger,
        runtime: {
            handleStreamControlResult: streamControl.handleStreamControlResult,
            persistSuccessAttributes: (attributes) =>
                authClient.persistSuccessAttributes(attributes),
            emitSuccessNode: (node) => host.emitEvent('success', node),
            updateClockSkewFromSuccess: host.updateClockSkewFromSuccess,
            shouldWarmupMediaConn: () => {
                const credentials = authClient.getCurrentCredentials()
                const comms = host.getComms()
                return !!(credentials?.meJid && comms && comms.getCommsState().connected)
            },
            warmupMediaConn: async () => {
                await getClientMediaConn(mediaMessageBuildOptions, true)
            },
            persistRoutingInfo: (routingInfo) => authClient.persistRoutingInfo(routingInfo),
            tryResolvePendingNode: (node) => nodeOrchestrator.tryResolvePending(node),
            handleGenericIncomingNode: (node) => nodeOrchestrator.handleIncomingNode(node),
            handleIncomingIqSetNode: (node) => authClient.handleIncomingIqSet(node),
            handleLinkCodeNotificationNode: (node) => authClient.handleLinkCodeNotification(node),
            handleCompanionRegRefreshNotificationNode: (node) =>
                authClient.handleCompanionRegRefreshNotification(node),
            handleIncomingMessageNode: (node) =>
                handleIncomingMessageAck(node, incomingMessageAckOptions),
            sendNode: host.sendNode,
            handleIncomingRetryReceipt: (node) => retryCoordinator.handleIncomingRetryReceipt(node),
            trackOutboundReceipt: (node) => retryCoordinator.trackOutboundReceipt(node),
            emitIncomingReceipt: (event) => host.emitEvent('incoming_receipt', event),
            emitIncomingPresence: (event) => host.emitEvent('incoming_presence', event),
            emitIncomingChatstate: (event) => host.emitEvent('incoming_chatstate', event),
            emitIncomingCall: (event) => host.emitEvent('incoming_call', event),
            emitIncomingFailure: (event) => host.emitEvent('incoming_failure', event),
            emitIncomingErrorStanza: (event) => host.emitEvent('incoming_error_stanza', event),
            emitIncomingNotification: (event) => host.emitEvent('incoming_notification', event),
            emitUnhandledIncomingNode: (event) =>
                host.emitEvent('incoming_unhandled_stanza', event),
            disconnect: host.disconnect,
            clearStoredCredentials: host.clearStoredState,
            parseDirtyBits: (nodes) => parseDirtyBits(nodes, logger),
            handleDirtyBits: (dirtyBits) => handleClientDirtyBits(dirtyBits)
        }
    })
    const passiveTasks = new WaPassiveTasksCoordinator({
        logger,
        signalStore: sessionStore.signal,
        runtime: {
            queryWithContext: host.queryWithContext,
            getCurrentCredentials: () => authClient.getCurrentCredentials(),
            persistServerHasPreKeys: (serverHasPreKeys) =>
                authClient.persistServerHasPreKeys(serverHasPreKeys),
            sendNodeDirect: async (node) => nodeOrchestrator.sendNode(node),
            takeDanglingReceipts: host.takeDanglingReceipts,
            requeueDanglingReceipt: host.enqueueDanglingReceipt,
            shouldQueueDanglingReceipt: host.shouldQueueDanglingReceipt
        }
    })

    return {
        nodeTransport,
        nodeOrchestrator,
        keepAlive,
        mediaTransfer,
        mediaMessageBuildOptions,
        messageClient,
        senderKeyManager,
        signalProtocol,
        signalDeviceSync,
        signalSessionSync,
        authClient,
        messageDispatch,
        retryCoordinator,
        appStateSync,
        streamControl,
        incomingNode,
        passiveTasks
    }
}
