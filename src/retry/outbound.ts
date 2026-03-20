import type { WaRetryOutboundState, WaRetryReplayPayload } from '@retry/types'
import { base64ToBytesChecked, bytesToBase64, TEXT_DECODER, TEXT_ENCODER } from '@util/bytes'

function requireObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
        throw new Error('invalid retry replay payload')
    }
    return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new Error(`invalid retry replay payload field: ${field}`)
    }
    return value
}

export function encodeRetryReplayPayload(payload: WaRetryReplayPayload): Uint8Array {
    const serialized =
        payload.mode === 'plaintext'
            ? {
                  mode: payload.mode,
                  to: payload.to,
                  type: payload.type,
                  plaintext: bytesToBase64(payload.plaintext)
              }
            : payload.mode === 'encrypted'
              ? {
                    mode: payload.mode,
                    to: payload.to,
                    type: payload.type,
                    encType: payload.encType,
                    ciphertext: bytesToBase64(payload.ciphertext),
                    participant: payload.participant
                }
              : {
                    mode: payload.mode,
                    node: bytesToBase64(payload.node)
                }
    return TEXT_ENCODER.encode(JSON.stringify(serialized))
}

export function decodeRetryReplayPayload(raw: Uint8Array): WaRetryReplayPayload {
    const json = JSON.parse(TEXT_DECODER.decode(raw))
    const parsed = requireObject(json)
    const mode = requireString(parsed.mode, 'mode')
    if (mode === 'plaintext') {
        return {
            mode,
            to: requireString(parsed.to, 'to'),
            type: requireString(parsed.type, 'type'),
            plaintext: base64ToBytesChecked(
                requireString(parsed.plaintext, 'plaintext'),
                'retry.plaintext'
            )
        }
    }
    if (mode === 'encrypted') {
        const encType = requireString(parsed.encType, 'encType')
        if (encType !== 'msg' && encType !== 'pkmsg' && encType !== 'skmsg') {
            throw new Error(`invalid retry encrypted encType: ${encType}`)
        }
        return {
            mode,
            to: requireString(parsed.to, 'to'),
            type: requireString(parsed.type, 'type'),
            encType,
            ciphertext: base64ToBytesChecked(
                requireString(parsed.ciphertext, 'ciphertext'),
                'retry.ciphertext'
            ),
            participant:
                parsed.participant === undefined
                    ? undefined
                    : requireString(parsed.participant, 'participant')
        }
    }
    if (mode === 'opaque_node') {
        return {
            mode,
            node: base64ToBytesChecked(requireString(parsed.node, 'node'), 'retry.node')
        }
    }
    throw new Error(`invalid retry replay payload mode: ${mode}`)
}

const RETRY_STATE_RANK: Readonly<Record<WaRetryOutboundState, number>> = {
    pending: 0,
    delivered: 1,
    read: 2,
    played: 3,
    ineligible: 4
}

export function pickRetryStateMax(
    left: WaRetryOutboundState,
    right: WaRetryOutboundState
): WaRetryOutboundState {
    return RETRY_STATE_RANK[left] >= RETRY_STATE_RANK[right] ? left : right
}
