import type { Proto } from '../proto'

export type ProtoSignalMessage = Proto.ISignalMessage
export type ProtoPreKeySignalMessage = Proto.IPreKeySignalMessage
export type ProtoSenderKeyDistributionMessage = Proto.ISenderKeyDistributionMessage
export type ProtoSessionStructure = Proto.ISessionStructure

export type SignalCiphertextType = 'msg' | 'pkmsg' | 'skmsg'

export interface SignalAddress {
    readonly user: string
    readonly server?: string
    readonly device: number
}

export interface SignalPeer {
    readonly regId: number
    readonly pubKey: Uint8Array
}

export interface SignalSerializedKeyPair {
    readonly pubKey: Uint8Array
    readonly privKey: Uint8Array
}

export interface SignalMessageKey {
    readonly index: number
    readonly cipherKey: Uint8Array
    readonly macKey: Uint8Array
    readonly iv: Uint8Array
}

export interface SignalRecvChain {
    readonly ratchetPubKey: Uint8Array
    readonly nextMsgIndex: number
    readonly chainKey: Uint8Array
    readonly unusedMsgKeys: readonly SignalMessageKey[]
}

export interface SignalSendChain {
    readonly ratchetKey: SignalSerializedKeyPair
    readonly nextMsgIndex: number
    readonly chainKey: Uint8Array
}

export interface SignalInitialExchangeInfo {
    readonly remoteOneTimeId: number | null
    readonly remoteSignedId: number
    readonly localOneTimePubKey: Uint8Array
}

export interface SignalSessionSnapshot {
    readonly local: SignalPeer
    readonly remote: SignalPeer
    readonly rootKey: Uint8Array
    readonly sendChain: SignalSendChain
    readonly recvChains: readonly SignalRecvChain[]
    readonly initialExchangeInfo: SignalInitialExchangeInfo | null
    readonly prevSendChainHighestIndex: number
    readonly aliceBaseKey: Uint8Array | null
}

export interface SignalSessionRecord extends SignalSessionSnapshot {
    readonly prevSessions: readonly SignalSessionSnapshot[]
}

export interface SignalPreKey {
    readonly id: number
    readonly publicKey: Uint8Array
}

export interface SignalSignedPreKey {
    readonly id: number
    readonly publicKey: Uint8Array
    readonly signature: Uint8Array
}

export interface SignalPreKeyBundle {
    readonly regId: number
    readonly identity: Uint8Array
    readonly signedKey: SignalSignedPreKey
    readonly oneTimeKey?: SignalPreKey
    readonly ratchetKey?: Uint8Array
}

export interface SignalCiphertext {
    readonly type: 'msg' | 'pkmsg'
    readonly ciphertext: Uint8Array
    readonly baseKey: Uint8Array | null
}

export interface SignalMessageEnvelope {
    readonly type: SignalCiphertextType
    readonly ciphertext: Uint8Array
}

export interface ParsedSignalMessage {
    readonly ratchetPubKey: Uint8Array
    readonly counter: number
    readonly ciphertext: Uint8Array
    readonly versionContentMac: Uint8Array
}

export interface ParsedPreKeySignalMessage extends ParsedSignalMessage {
    readonly remote: SignalPeer
    readonly sessionBaseKey: Uint8Array
    readonly localSignedPreKeyId: number
    readonly localOneTimeKeyId: number | null
}

export interface SenderKeyRecord {
    readonly groupId: string
    readonly sender: SignalAddress
    readonly keyId: number
    readonly iteration: number
    readonly chainKey: Uint8Array
    readonly signingPublicKey: Uint8Array
    readonly signingPrivateKey?: Uint8Array
    readonly unusedMessageKeys?: readonly SenderMessageKey[]
}

export interface SenderMessageKey {
    readonly iteration: number
    readonly seed: Uint8Array
}

export interface SenderKeyDistributionRecord {
    readonly groupId: string
    readonly sender: SignalAddress
    readonly keyId: number
    readonly timestampMs: number
}

export interface GroupSenderKeyList {
    readonly skList: readonly SenderKeyRecord[]
    readonly skDistribList: readonly SenderKeyDistributionRecord[]
}

export interface GroupSenderKeyCiphertext {
    readonly groupId: string
    readonly sender: SignalAddress
    readonly keyId: number
    readonly iteration: number
    readonly ciphertext: Uint8Array
}
