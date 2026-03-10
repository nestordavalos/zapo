import type { WaAuthCredentials } from '../../auth/types'
import { randomBytesAsync } from '../../crypto'
import { toSerializedPubKey } from '../../crypto/core/keys'
import { X25519 } from '../../crypto/curves/X25519'
import type { Logger } from '../../infra/log/types'
import { generatePreKeyPair, generateRegistrationInfo, generateSignedPreKey } from '../../signal/api/utils'
import { WaAdvSignature } from '../../signal/crypto/WaAdvSignature'
import { createAndStoreInitialKeys } from '../../signal/registration/utils'
import { WaSignalStore } from '../../signal/store/WaSignalStore'
import type { WaCommsConfig } from '../../transport/types'
import { toError } from '../../util/errors'
import { WaAuthStateStore } from '../store/WaAuthStateStore'

import { getLoginIdentity } from './identity'
import type { WaAuthSocketOptions } from './types'

export class WaAuthCredentialsFlow {
    private readonly logger: Logger
    private readonly authStore: WaAuthStateStore
    private readonly signalStore: WaSignalStore
    private readonly x25519: X25519
    private readonly advSignature: WaAdvSignature

    public constructor(args: {
        readonly logger: Logger
        readonly authStore: WaAuthStateStore
        readonly signalStore: WaSignalStore
        readonly x25519: X25519
        readonly advSignature?: WaAdvSignature
    }) {
        this.logger = args.logger
        this.authStore = args.authStore
        this.signalStore = args.signalStore
        this.x25519 = args.x25519
        this.advSignature = args.advSignature ?? new WaAdvSignature()
    }

    public async loadOrCreateCredentials(): Promise<WaAuthCredentials> {
        this.logger.trace('auth credentials loadOrCreate start')
        const existing = await this.authStore.load()
        if (existing) {
            this.logger.debug('auth credentials loaded from store', {
                registered: existing.meJid !== null && existing.meJid !== undefined,
                hasServerStaticKey: existing.serverStaticKey !== null && existing.serverStaticKey !== undefined
            })
            if (!existing.meJid) {
                const validSignedPreKey = await this.hasValidSignedPreKey(existing)
                if (!validSignedPreKey) {
                    this.logger.warn('signed pre-key is invalid, regenerating credentials')
                    const fresh = await this.createFreshCredentials()
                    await this.authStore.save(fresh)
                    await this.signalStore.setRegistrationInfo(fresh.registrationInfo)
                    await this.signalStore.setSignedPreKey(fresh.signedPreKey)
                    await this.signalStore.setServerHasPreKeys(fresh.serverHasPreKeys === true)
                    this.logger.info('regenerated credentials due to invalid signed pre-key')
                    return fresh
                }
            }
            await this.signalStore.setRegistrationInfo(existing.registrationInfo)
            await this.signalStore.setSignedPreKey(existing.signedPreKey)
            await this.signalStore.setServerHasPreKeys(existing.serverHasPreKeys === true)
            this.logger.trace('auth credentials restored into signal store')
            return existing
        }

        const credentials = await this.createFreshCredentials()
        await this.authStore.save(credentials)
        this.logger.info('created fresh auth credentials')
        return credentials
    }

    public async persistCredentials(credentials: WaAuthCredentials): Promise<void> {
        this.logger.trace('persisting auth credentials', {
            registered: credentials.meJid !== null && credentials.meJid !== undefined
        })
        await this.authStore.save(credentials)
    }

    public buildCommsConfig(
        credentials: WaAuthCredentials,
        socketOptions: WaAuthSocketOptions
    ): WaCommsConfig {
        const registered = credentials.meJid !== null && credentials.meJid !== undefined
        const loginIdentity = registered ? getLoginIdentity(credentials.meJid) : null
        this.logger.debug('building comms config from credentials', {
            registered,
            hasServerStaticKey: credentials.serverStaticKey !== null && credentials.serverStaticKey !== undefined
        })

        return {
            url: socketOptions.url,
            urls: socketOptions.urls,
            protocols: socketOptions.protocols,
            connectTimeoutMs: socketOptions.connectTimeoutMs,
            reconnectIntervalMs: socketOptions.reconnectIntervalMs,
            timeoutIntervalMs: socketOptions.timeoutIntervalMs,
            maxReconnectAttempts: socketOptions.maxReconnectAttempts,
            noise: {
                clientStaticKeyPair: credentials.noiseKeyPair,
                isRegistered: registered,
                serverStaticKey: credentials.serverStaticKey,
                routingInfo: credentials.routingInfo,
                loginPayloadConfig: loginIdentity
                    ? {
                          username: loginIdentity.username,
                          device: loginIdentity.device
                      }
                    : undefined,
                registrationPayloadConfig: !loginIdentity
                    ? {
                          registrationInfo: credentials.registrationInfo,
                          signedPreKey: credentials.signedPreKey
                      }
                    : undefined
            }
        }
    }

    private async createFreshCredentials(): Promise<WaAuthCredentials> {
        this.logger.trace('creating fresh credentials')
        const noiseKeyPair = await this.x25519.generateKeyPair()
        const registrationBundle = await createAndStoreInitialKeys(this.signalStore, {
            generateRegistrationInfo: async () => generateRegistrationInfo(this.x25519),
            generatePreKeyPair: async (keyId) => generatePreKeyPair(this.x25519, keyId),
            generateSignedPreKey: async (keyId, signingPrivateKey) =>
                generateSignedPreKey(this.x25519, this.advSignature, keyId, signingPrivateKey)
        })
        return {
            noiseKeyPair,
            registrationInfo: registrationBundle.registrationInfo,
            signedPreKey: registrationBundle.signedPreKey,
            serverHasPreKeys: false,
            advSecretKey: await randomBytesAsync(32)
        }
    }

    private async hasValidSignedPreKey(credentials: WaAuthCredentials): Promise<boolean> {
        try {
            const serializedPubKey = toSerializedPubKey(credentials.signedPreKey.keyPair.pubKey)
            const valid = await this.advSignature.verifySignalSignature(
                credentials.registrationInfo.identityKeyPair.pubKey,
                serializedPubKey,
                credentials.signedPreKey.signature
            )
            this.logger.trace('signed pre-key validation completed', { valid })
            return valid
        } catch (error) {
            this.logger.warn('signed pre-key validation failed with exception', {
                message: toError(error).message
            })
            return false
        }
    }
}
