import {
    aesCbcDecrypt,
    aesCbcEncrypt,
    importAesCbcKey,
    toSerializedPubKey,
    prependVersion,
    randomBytesAsync,
    randomIntAsync,
    X25519
} from '@crypto'
import { proto } from '@proto'
import { SIGNAL_GROUP_VERSION, SIGNATURE_SIZE } from '@signal/constants'
import { WaAdvSignature } from '@signal/crypto/WaAdvSignature'
import { deriveSenderKeyMsgKey, selectMessageKey } from '@signal/group/SenderKeyChain'
import { parseDistributionPayload, parseSenderKeyMessage } from '@signal/group/SenderKeyCodec'
import type { SenderKeyRecord, SignalAddress } from '@signal/types'
import type { WaSenderKeyStore } from '@store/contracts/sender-key.store'
import { concatBytes } from '@util/bytes'

interface GroupSenderKeyCiphertext {
    readonly groupId: string
    readonly sender: SignalAddress
    readonly keyId?: number
    readonly iteration?: number
    readonly ciphertext: Uint8Array
}

export class SenderKeyManager {
    private readonly store: WaSenderKeyStore

    public constructor(store: WaSenderKeyStore) {
        this.store = store
    }

    public async createSenderKeyDistributionMessage(
        groupId: string,
        sender: SignalAddress
    ): Promise<Uint8Array> {
        const senderKey = await this.ensureSenderKey(groupId, sender)
        const distributionProto = proto.SenderKeyDistributionMessage.encode({
            id: senderKey.keyId,
            iteration: senderKey.iteration,
            chainKey: senderKey.chainKey,
            signingKey: senderKey.signingPublicKey
        }).finish()
        const payload = prependVersion(distributionProto, SIGNAL_GROUP_VERSION)

        await this.store.upsertSenderKeyDistribution({
            groupId,
            sender,
            keyId: senderKey.keyId,
            timestampMs: Date.now()
        })

        const distribution = proto.Message.SenderKeyDistributionMessage.encode({
            groupId,
            axolotlSenderKeyDistributionMessage: payload
        }).finish()
        return distribution
    }

    public async processSenderKeyDistributionMessage(
        sender: SignalAddress,
        data: Uint8Array
    ): Promise<SenderKeyRecord> {
        const decoded = proto.Message.SenderKeyDistributionMessage.decode(data)
        const groupId = decoded.groupId ?? ''
        if (groupId.length === 0) {
            throw new Error('sender key distribution missing groupId')
        }
        if (!decoded.axolotlSenderKeyDistributionMessage) {
            throw new Error('sender key distribution missing payload')
        }

        return this.processSenderKeyDistributionPayload(
            groupId,
            sender,
            decoded.axolotlSenderKeyDistributionMessage
        )
    }

    public async processSenderKeyDistributionPayload(
        groupId: string,
        sender: SignalAddress,
        payload: Uint8Array
    ): Promise<SenderKeyRecord> {
        if (groupId.length === 0) {
            throw new Error('sender key distribution missing groupId')
        }

        const parsed = parseDistributionPayload(payload)
        const record: SenderKeyRecord = {
            groupId,
            sender,
            keyId: parsed.keyId,
            iteration: parsed.iteration,
            chainKey: parsed.chainKey,
            signingPublicKey: parsed.signingPublicKey,
            unusedMessageKeys: []
        }
        await this.store.upsertSenderKey(record)
        await this.store.upsertSenderKeyDistribution({
            groupId,
            sender,
            keyId: parsed.keyId,
            timestampMs: Date.now()
        })
        return record
    }

    public async encryptGroupMessage(
        groupId: string,
        sender: SignalAddress,
        plaintext: Uint8Array
    ): Promise<GroupSenderKeyCiphertext> {
        const senderKey = await this.ensureSenderKey(groupId, sender)
        if (!senderKey.signingPrivateKey) {
            throw new Error('sender private signing key is missing')
        }

        const derived = await deriveSenderKeyMsgKey(senderKey.iteration, senderKey.chainKey)
        const messagePayload = await this.aesCbcEncryptFromSeed(derived.messageKey.seed, plaintext)
        const senderKeyMessage = proto.SenderKeyMessage.encode({
            id: senderKey.keyId,
            iteration: derived.messageKey.iteration,
            ciphertext: messagePayload
        }).finish()
        const versionedContent = prependVersion(senderKeyMessage, SIGNAL_GROUP_VERSION)
        const signature = await WaAdvSignature.signSignalMessage(
            senderKey.signingPrivateKey,
            versionedContent
        )
        if (signature.length !== SIGNATURE_SIZE) {
            throw new Error(`invalid sender key signature length ${signature.length}`)
        }
        const ciphertext = concatBytes([versionedContent, signature])

        await this.store.upsertSenderKey({
            ...senderKey,
            chainKey: derived.nextChainKey,
            iteration: derived.messageKey.iteration + 1
        })

        return {
            groupId,
            sender,
            keyId: senderKey.keyId,
            iteration: derived.messageKey.iteration,
            ciphertext
        }
    }

    public async decryptGroupMessage(payload: GroupSenderKeyCiphertext): Promise<Uint8Array> {
        const parsed = parseSenderKeyMessage(payload.ciphertext)

        const senderKey = await this.store.getDeviceSenderKey(payload.groupId, payload.sender)
        if (!senderKey) {
            throw new Error('missing sender key')
        }
        if (senderKey.keyId !== parsed.keyId) {
            throw new Error('sender key id mismatch')
        }

        if (
            payload.keyId !== undefined &&
            payload.keyId !== null &&
            parsed.keyId !== payload.keyId
        ) {
            throw new Error('sender key id mismatch')
        }
        if (
            payload.iteration !== undefined &&
            payload.iteration !== null &&
            parsed.iteration !== payload.iteration
        ) {
            throw new Error('sender key iteration mismatch')
        }

        const signedContent = parsed.versionContentMac.subarray(
            0,
            parsed.versionContentMac.length - SIGNATURE_SIZE
        )
        const signature = parsed.versionContentMac.subarray(
            parsed.versionContentMac.length - SIGNATURE_SIZE
        )
        const validSignature = await WaAdvSignature.verifySignalSignature(
            senderKey.signingPublicKey,
            signedContent,
            signature
        )
        if (!validSignature) {
            throw new Error('invalid sender key signature')
        }

        const selected = await selectMessageKey(senderKey, parsed.iteration)
        const plaintext = await this.aesCbcDecryptFromSeed(
            selected.messageKey.seed,
            parsed.ciphertext
        )
        await this.store.upsertSenderKey(selected.updatedRecord)
        return plaintext
    }

    private async ensureSenderKey(
        groupId: string,
        sender: SignalAddress
    ): Promise<SenderKeyRecord> {
        const existing = await this.store.getDeviceSenderKey(groupId, sender)
        if (existing) {
            return existing
        }

        const signingKeyPair = await X25519.generateKeyPair()
        const created: SenderKeyRecord = {
            groupId,
            sender,
            keyId: await randomIntAsync(1, 2_147_483_647),
            iteration: 0,
            chainKey: await randomBytesAsync(32),
            signingPublicKey: toSerializedPubKey(signingKeyPair.pubKey),
            signingPrivateKey: signingKeyPair.privKey,
            unusedMessageKeys: []
        }
        await this.store.upsertSenderKey(created)
        return created
    }

    private async aesCbcEncryptFromSeed(
        seed: Uint8Array,
        plaintext: Uint8Array
    ): Promise<Uint8Array> {
        const { keyBytes, iv } = this.extractAesCbcParams(seed)
        const key = await importAesCbcKey(keyBytes)
        return aesCbcEncrypt(key, iv, plaintext)
    }

    private async aesCbcDecryptFromSeed(
        seed: Uint8Array,
        ciphertext: Uint8Array
    ): Promise<Uint8Array> {
        const { keyBytes, iv } = this.extractAesCbcParams(seed)
        const key = await importAesCbcKey(keyBytes)
        return aesCbcDecrypt(key, iv, ciphertext)
    }

    private extractAesCbcParams(seed: Uint8Array): { keyBytes: Uint8Array; iv: Uint8Array } {
        if (seed.length < 48) {
            throw new Error('sender key message seed must be at least 48 bytes')
        }

        const iv = seed.subarray(0, 16)
        const keyBytes = seed.subarray(16, 48)
        return {
            keyBytes,
            iv
        }
    }
}
