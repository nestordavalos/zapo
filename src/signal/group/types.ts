export interface ParsedDistributionPayload {
    readonly keyId: number
    readonly iteration: number
    readonly chainKey: Uint8Array
    readonly signingPublicKey: Uint8Array
}

export interface ParsedSenderKeyMessage {
    readonly keyId: number
    readonly iteration: number
    readonly ciphertext: Uint8Array
    readonly versionContentMac: Uint8Array
}
