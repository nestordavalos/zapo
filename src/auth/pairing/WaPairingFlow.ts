import { completeCompanionFinish, createCompanionHello } from '@auth/pairing/WaPairingCodeCrypto'
import type { WaAuthCredentials } from '@auth/types'
import { randomBytesAsync } from '@crypto'
import type { SignalKeyPair } from '@crypto/curves/types'
import type { Logger } from '@infra/log/types'
import { proto } from '@proto'
import { WA_DEFAULTS, WA_IQ_TYPES, WA_NODE_TAGS, WA_SIGNALING } from '@protocol/constants'
import { parsePhoneJid } from '@protocol/jid'
import { ADV_PREFIX_HOSTED_ACCOUNT_SIGNATURE, WaAdvSignature } from '@signal/crypto/WaAdvSignature'
import {
    buildCompanionFinishRequestNode,
    buildCompanionHelloRequestNode,
    buildGetCountryCodeRequestNode,
    buildIqResultNode,
    buildNotificationAckNode
} from '@transport/node/builders/pairing'
import {
    decodeNodeContentUtf8OrBytes,
    findNodeChild,
    getFirstNodeChild,
    getNodeChildrenByTag,
    hasNodeChild
} from '@transport/node/helpers'
import type { BinaryNode } from '@transport/types'
import { decodeProtoBytes } from '@util/base64'
import { concatBytes, TEXT_DECODER, uint8Equal } from '@util/bytes'

const BROWSER_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
    chrome: 'Chrome',
    firefox: 'Firefox',
    ie: 'IE',
    opera: 'Opera',
    safari: 'Safari',
    edge: 'Edge',
    chromium: 'Chromium'
})

function getBrowserDisplayName(browser: string): string {
    const normalized = browser.trim().toLowerCase()
    return BROWSER_DISPLAY_NAMES[normalized] ?? browser
}

interface ActivePairingSession {
    readonly ref?: Uint8Array
    readonly createdAtSeconds: number
    readonly companionEphemeralKeyPair: SignalKeyPair
    readonly phoneJid: string
    readonly pairingCode: string
    attempts: number
    finished: boolean
}

interface WaPairingFlowOptions {
    readonly logger: Logger
    readonly getCredentials: () => WaAuthCredentials | null
    readonly updateCredentials: (credentials: WaAuthCredentials) => Promise<void>
    readonly sendNode: (node: BinaryNode) => Promise<void>
    readonly query: (node: BinaryNode, timeoutMs: number) => Promise<BinaryNode>
    readonly setQrRefs: (refs: readonly string[]) => void
    readonly clearQr: () => void
    readonly refreshQr: () => void
    readonly getDeviceBrowser: () => string
    readonly getDeviceOsDisplayName: () => string
    readonly getDevicePlatform: () => string
    readonly emitPairingCode: (code: string) => void
    readonly emitPairingRefresh: (forceManual: boolean) => void
    readonly emitPaired: (credentials: WaAuthCredentials) => void
}

export class WaPairingFlow {
    private readonly opts: WaPairingFlowOptions
    private pairingSession: ActivePairingSession | null

    public constructor(options: WaPairingFlowOptions) {
        this.opts = options
        this.pairingSession = null
    }

    public hasPairingSession(): boolean {
        return this.pairingSession !== null
    }

    public clearSession(): void {
        this.opts.logger.trace('pairing flow session cleared')
        this.pairingSession = null
    }

    public async requestPairingCode(
        phoneNumber: string,
        shouldShowPushNotification = false
    ): Promise<string> {
        this.opts.logger.info('requesting pairing code', {
            shouldShowPushNotification
        })
        const credentials = this.requireCredentials()
        const phoneJid = parsePhoneJid(phoneNumber)
        const companionHello = await createCompanionHello()
        const refreshedCredentials = await this.rotateAdvSecret(credentials)

        const response = await this.opts.query(
            buildCompanionHelloRequestNode({
                phoneJid,
                shouldShowPushNotification,
                wrappedCompanionEphemeralPub: companionHello.wrappedCompanionEphemeralPub,
                companionServerAuthKeyPub: refreshedCredentials.noiseKeyPair.pubKey,
                companionPlatformId: this.opts.getDevicePlatform(),
                companionPlatformDisplay: `${getBrowserDisplayName(this.opts.getDeviceBrowser())} (${this.opts.getDeviceOsDisplayName()})`
            }),
            WA_DEFAULTS.IQ_TIMEOUT_MS
        )
        this.opts.logger.debug('pairing code request response received', {
            responseTag: response.tag,
            responseType: response.attrs.type
        })

        const linkCodeNode = findNodeChild(response, WA_NODE_TAGS.LINK_CODE_COMPANION_REG)
        if (!linkCodeNode) {
            throw new Error('companion hello response missing link_code_companion_reg')
        }
        const refNode = findNodeChild(linkCodeNode, WA_NODE_TAGS.LINK_CODE_PAIRING_REF)
        if (!refNode) {
            throw new Error('companion hello response missing link_code_pairing_ref')
        }

        const ref = decodeNodeContentUtf8OrBytes(refNode.content, 'link_code_pairing_ref')
        this.pairingSession = {
            pairingCode: companionHello.pairingCode,
            phoneJid,
            ref,
            createdAtSeconds: Math.floor(Date.now() / 1000),
            companionEphemeralKeyPair: companionHello.companionEphemeralKeyPair,
            attempts: 0,
            finished: false
        }
        this.opts.emitPairingCode(companionHello.pairingCode)
        this.opts.logger.info('pairing code emitted', {
            phoneJid,
            createdAtSeconds: this.pairingSession.createdAtSeconds
        })
        return companionHello.pairingCode
    }

    public async fetchPairingCountryCodeIso(): Promise<string> {
        this.opts.logger.trace('fetching pairing country code ISO')
        const response = await this.opts.query(
            buildGetCountryCodeRequestNode(),
            WA_DEFAULTS.IQ_TIMEOUT_MS
        )
        const countryCodeNode = findNodeChild(response, WA_NODE_TAGS.COUNTRY_CODE)
        const iso = countryCodeNode?.attrs.iso
        if (!iso) {
            throw new Error('country_code response is missing iso')
        }
        this.opts.logger.debug('pairing country code received', { iso })
        return iso
    }

    public async handleIncomingIqSet(node: BinaryNode): Promise<boolean> {
        this.opts.logger.trace('pairing flow received iq:set', {
            id: node.attrs.id,
            from: node.attrs.from
        })
        const firstChild = getFirstNodeChild(node)
        if (!firstChild) {
            return false
        }
        if (firstChild.tag === WA_NODE_TAGS.PAIR_DEVICE) {
            this.opts.logger.debug('handling pair-device stanza', { id: node.attrs.id })
            await this.handlePairDevice(node, firstChild)
            return true
        }
        if (firstChild.tag === WA_NODE_TAGS.PAIR_SUCCESS) {
            this.opts.logger.debug('handling pair-success stanza', { id: node.attrs.id })
            await this.handlePairSuccess(node, firstChild)
            return true
        }
        return false
    }

    public async handleLinkCodeNotification(node: BinaryNode): Promise<boolean> {
        const linkCodeNode = findNodeChild(node, WA_NODE_TAGS.LINK_CODE_COMPANION_REG)
        if (!linkCodeNode) {
            return false
        }
        this.opts.logger.trace('handling link_code_companion_reg notification', {
            id: node.attrs.id,
            stage: linkCodeNode.attrs.stage
        })
        await this.opts.sendNode(buildNotificationAckNode(node))

        const stage = linkCodeNode.attrs.stage
        if (stage === WA_SIGNALING.LINK_CODE_STAGE_REFRESH_CODE) {
            const refNode = findNodeChild(linkCodeNode, WA_NODE_TAGS.LINK_CODE_PAIRING_REF)
            if (!refNode || !this.pairingSession?.ref) {
                return true
            }
            const ref = decodeNodeContentUtf8OrBytes(
                refNode.content,
                'refresh_code.link_code_pairing_ref'
            )
            if (uint8Equal(ref, this.pairingSession.ref)) {
                this.opts.logger.info('received pairing refresh notification', {
                    forceManualRefresh: linkCodeNode.attrs.force_manual_refresh === 'true'
                })
                this.opts.emitPairingRefresh(linkCodeNode.attrs.force_manual_refresh === 'true')
            }
            return true
        }

        if (stage !== WA_SIGNALING.LINK_CODE_STAGE_PRIMARY_HELLO) {
            return true
        }
        await this.handlePrimaryHello(linkCodeNode)
        return true
    }

    public async handleCompanionRegRefreshNotification(node: BinaryNode): Promise<boolean> {
        if (
            node.tag !== WA_NODE_TAGS.NOTIFICATION ||
            node.attrs.type !== WA_SIGNALING.COMPANION_REG_REFRESH_NOTIFICATION
        ) {
            return false
        }
        const hasExpectedChild =
            hasNodeChild(node, WA_SIGNALING.COMPANION_REG_REFRESH_NOTIFICATION) ||
            hasNodeChild(node, 'pair-device-rotate-qr')
        if (!hasExpectedChild) {
            return false
        }

        await this.opts.sendNode(
            buildNotificationAckNode(node, WA_SIGNALING.COMPANION_REG_REFRESH_NOTIFICATION)
        )
        await this.rotateAdvSecret(this.requireCredentials())
        this.opts.logger.info('handled companion_reg_refresh notification')
        this.opts.refreshQr()
        return true
    }

    private async handlePairDevice(iqNode: BinaryNode, pairDeviceNode: BinaryNode): Promise<void> {
        const refs = getNodeChildrenByTag(pairDeviceNode, WA_NODE_TAGS.REF)
            .map((child) =>
                TEXT_DECODER.decode(decodeNodeContentUtf8OrBytes(child.content, 'pair-device.ref'))
            )
            .filter((ref) => ref.length > 0)
        await this.rotateAdvSecret(this.requireCredentials())
        this.opts.setQrRefs(refs)
        this.opts.logger.info('pair-device refs updated', { refsCount: refs.length })
        await this.opts.sendNode(buildIqResultNode(iqNode))
    }

    private async handlePairSuccess(
        iqNode: BinaryNode,
        pairSuccessNode: BinaryNode
    ): Promise<void> {
        this.opts.logger.info('processing pair-success node')
        const credentials = this.requireCredentials()
        const { deviceIdentityNode, deviceNode, platformNode } =
            this.requirePairSuccessNodes(pairSuccessNode)
        const wrappedIdentity = proto.ADVSignedDeviceIdentityHMAC.decode(
            decodeNodeContentUtf8OrBytes(deviceIdentityNode.content, 'pair-success.device-identity')
        )
        const { wrappedDetails, isHosted } = await this.verifyWrappedIdentityHmac(
            credentials,
            wrappedIdentity
        )
        const { signedIdentity, keyIndex, responseIdentityBytes } =
            await this.buildPairSuccessResponseIdentity(credentials, wrappedDetails, isHosted)
        const nextCredentials: WaAuthCredentials = {
            ...credentials,
            signedIdentity,
            meJid: deviceNode.attrs.jid,
            meLid: deviceNode.attrs.lid,
            platform: platformNode.attrs.name
        }
        await this.opts.updateCredentials(nextCredentials)
        this.opts.logger.info('pair-success credentials updated', {
            meJid: nextCredentials.meJid,
            meLid: nextCredentials.meLid,
            platform: nextCredentials.platform
        })
        this.opts.clearQr()
        await this.sendPairSuccessResult(iqNode, responseIdentityBytes, keyIndex)
        this.opts.emitPaired(nextCredentials)
        this.opts.logger.debug('pair-success completed and paired event emitted')
    }

    private requirePairSuccessNodes(pairSuccessNode: BinaryNode): {
        readonly deviceIdentityNode: BinaryNode
        readonly deviceNode: BinaryNode
        readonly platformNode: BinaryNode
    } {
        const deviceIdentityNode = findNodeChild(pairSuccessNode, WA_NODE_TAGS.DEVICE_IDENTITY)
        const deviceNode = findNodeChild(pairSuccessNode, 'device')
        const platformNode = findNodeChild(pairSuccessNode, WA_NODE_TAGS.PLATFORM)
        if (!deviceIdentityNode || !deviceNode || !platformNode) {
            this.opts.logger.error('pair-success missing required nodes', {
                hasDeviceIdentity: !!deviceIdentityNode,
                hasDevice: !!deviceNode,
                hasPlatform: !!platformNode
            })
            throw new Error('pair-success stanza is missing required nodes')
        }
        return { deviceIdentityNode, deviceNode, platformNode }
    }

    private async verifyWrappedIdentityHmac(
        credentials: WaAuthCredentials,
        wrappedIdentity: ReturnType<typeof proto.ADVSignedDeviceIdentityHMAC.decode>
    ): Promise<{
        readonly wrappedDetails: Uint8Array
        readonly isHosted: boolean
    }> {
        const wrappedDetails = decodeProtoBytes(
            wrappedIdentity.details,
            'ADVSignedDeviceIdentityHMAC.details'
        )
        const wrappedHmac = decodeProtoBytes(
            wrappedIdentity.hmac,
            'ADVSignedDeviceIdentityHMAC.hmac'
        )
        const accountType = wrappedIdentity.accountType ?? proto.ADVEncryptionType.E2EE
        const isHosted = accountType === proto.ADVEncryptionType.HOSTED
        const hmacInput = isHosted
            ? concatBytes([ADV_PREFIX_HOSTED_ACCOUNT_SIGNATURE, wrappedDetails])
            : wrappedDetails
        const expectedHmac = await WaAdvSignature.computeAdvIdentityHmac(
            credentials.advSecretKey,
            hmacInput
        )
        if (!uint8Equal(expectedHmac, wrappedHmac)) {
            this.opts.logger.error('pair-success hmac mismatch')
            throw new Error('pair-success HMAC validation failed')
        }
        return { wrappedDetails, isHosted }
    }

    private async buildPairSuccessResponseIdentity(
        credentials: WaAuthCredentials,
        wrappedDetails: Uint8Array,
        isHosted: boolean
    ): Promise<{
        readonly signedIdentity: ReturnType<typeof proto.ADVSignedDeviceIdentity.decode>
        readonly keyIndex: number
        readonly responseIdentityBytes: Uint8Array
    }> {
        const signedIdentity = proto.ADVSignedDeviceIdentity.decode(wrappedDetails)
        const details = decodeProtoBytes(signedIdentity.details, 'ADVSignedDeviceIdentity.details')
        const accountSignature = decodeProtoBytes(
            signedIdentity.accountSignature,
            'ADVSignedDeviceIdentity.accountSignature'
        )
        const accountSignatureKey = decodeProtoBytes(
            signedIdentity.accountSignatureKey,
            'ADVSignedDeviceIdentity.accountSignatureKey'
        )
        const localIdentity = credentials.registrationInfo.identityKeyPair
        const validAccountSignature = await WaAdvSignature.verifyDeviceIdentityAccountSignature(
            details,
            accountSignature,
            localIdentity.pubKey,
            accountSignatureKey,
            isHosted
        )
        if (!validAccountSignature) {
            this.opts.logger.error('pair-success account signature invalid')
            throw new Error('pair-success account signature validation failed')
        }

        signedIdentity.deviceSignature = await WaAdvSignature.generateDeviceSignature(
            details,
            localIdentity,
            accountSignatureKey,
            isHosted
        )
        const advDeviceIdentity = proto.ADVDeviceIdentity.decode(details)
        const responseIdentityBytes = proto.ADVSignedDeviceIdentity.encode({
            details: signedIdentity.details,
            accountSignature: signedIdentity.accountSignature,
            deviceSignature: signedIdentity.deviceSignature
        }).finish()
        return {
            signedIdentity,
            keyIndex: advDeviceIdentity.keyIndex ?? 0,
            responseIdentityBytes
        }
    }

    private async sendPairSuccessResult(
        iqNode: BinaryNode,
        responseIdentityBytes: Uint8Array,
        keyIndex: number
    ): Promise<void> {
        await this.opts.sendNode({
            tag: WA_NODE_TAGS.IQ,
            attrs: {
                ...(iqNode.attrs.id ? { id: iqNode.attrs.id } : {}),
                to: iqNode.attrs.from ?? WA_DEFAULTS.HOST_DOMAIN,
                type: WA_IQ_TYPES.RESULT
            },
            content: [
                {
                    tag: 'pair-device-sign',
                    attrs: {},
                    content: [
                        {
                            tag: WA_NODE_TAGS.DEVICE_IDENTITY,
                            attrs: {
                                'key-index': String(keyIndex)
                            },
                            content: responseIdentityBytes
                        }
                    ]
                }
            ]
        })
    }

    private async handlePrimaryHello(linkCodeNode: BinaryNode): Promise<void> {
        const credentials = this.requireCredentials()
        const pairingSession = this.pairingSession
        if (!pairingSession || pairingSession.finished) {
            this.opts.logger.trace('primary_hello ignored: no active session')
            return
        }

        pairingSession.attempts += 1
        this.opts.logger.debug('processing primary_hello', {
            attempts: pairingSession.attempts
        })
        if (pairingSession.attempts > 3) {
            throw new Error('pairing code exceeded maximum primary hello attempts')
        }

        const refNode = findNodeChild(linkCodeNode, WA_NODE_TAGS.LINK_CODE_PAIRING_REF)
        const wrappedPrimaryNode = findNodeChild(
            linkCodeNode,
            'link_code_pairing_wrapped_primary_ephemeral_pub'
        )
        const primaryIdentityNode = findNodeChild(linkCodeNode, 'primary_identity_pub')
        if (!refNode || !wrappedPrimaryNode || !primaryIdentityNode) {
            throw new Error('primary_hello notification is missing fields')
        }

        const ref = decodeNodeContentUtf8OrBytes(
            refNode.content,
            'primary_hello.link_code_pairing_ref'
        )
        if (!pairingSession.ref || !uint8Equal(ref, pairingSession.ref)) {
            this.opts.logger.warn('primary_hello ref mismatch ignored')
            return
        }

        const nowSeconds = Math.floor(Date.now() / 1000)
        if (
            nowSeconds - pairingSession.createdAtSeconds >
            WA_DEFAULTS.PAIRING_CODE_MAX_AGE_SECONDS
        ) {
            throw new Error('primary_hello received for an expired pairing code')
        }

        const finish = await completeCompanionFinish({
            pairingCode: pairingSession.pairingCode,
            wrappedPrimaryEphemeralPub: decodeNodeContentUtf8OrBytes(
                wrappedPrimaryNode.content,
                'primary_hello.link_code_pairing_wrapped_primary_ephemeral_pub'
            ),
            primaryIdentityPub: decodeNodeContentUtf8OrBytes(
                primaryIdentityNode.content,
                'primary_hello.primary_identity_pub'
            ),
            companionEphemeralPrivKey: pairingSession.companionEphemeralKeyPair.privKey,
            registrationIdentityKeyPair: credentials.registrationInfo.identityKeyPair
        })

        await this.opts.updateCredentials({
            ...credentials,
            advSecretKey: finish.advSecret
        })

        const result = await this.opts.query(
            buildCompanionFinishRequestNode({
                phoneJid: pairingSession.phoneJid,
                wrappedKeyBundle: finish.wrappedKeyBundle,
                companionIdentityPublic: finish.companionIdentityPublic,
                ref
            }),
            WA_DEFAULTS.IQ_TIMEOUT_MS
        )
        if (result.attrs.type === WA_IQ_TYPES.ERROR) {
            throw new Error('companion_finish returned error')
        }
        pairingSession.finished = true
        this.opts.logger.info('primary_hello completed with companion_finish success')
    }

    private async rotateAdvSecret(credentials: WaAuthCredentials): Promise<WaAuthCredentials> {
        const nextCredentials = {
            ...credentials,
            advSecretKey: await randomBytesAsync(32)
        }
        await this.opts.updateCredentials(nextCredentials)
        return nextCredentials
    }

    private requireCredentials(): WaAuthCredentials {
        const credentials = this.opts.getCredentials()
        if (!credentials) {
            throw new Error('credentials are not initialized')
        }
        return credentials
    }
}
