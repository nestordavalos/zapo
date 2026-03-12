import type { WaRetryOutboundState, WaRetryReplayPayload } from '@retry/types'
import { base64ToBytes, bytesToBase64 } from '@util/base64'
import { TEXT_DECODER, TEXT_ENCODER } from '@util/bytes'

type SerializedReplayPayload =
    | {
          readonly mode: 'plaintext'
          readonly to: string
          readonly type: string
          readonly plaintext: string
      }
    | {
          readonly mode: 'encrypted'
          readonly to: string
          readonly type: string
          readonly encType: 'msg' | 'pkmsg' | 'skmsg'
          readonly ciphertext: string
          readonly participant?: string
      }
    | {
          readonly mode: 'opaque_node'
          readonly node: string
      }

function assertObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
        throw new Error('invalid retry replay payload')
    }
    return value as Record<string, unknown>
}

function assertString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new Error(`invalid retry replay payload field: ${field}`)
    }
    return value
}

export function encodeRetryReplayPayload(payload: WaRetryReplayPayload): Uint8Array {
    const serialized: SerializedReplayPayload =
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
    const parsed = assertObject(json)
    const mode = assertString(parsed.mode, 'mode')
    if (mode === 'plaintext') {
        return {
            mode,
            to: assertString(parsed.to, 'to'),
            type: assertString(parsed.type, 'type'),
            plaintext: base64ToBytes(assertString(parsed.plaintext, 'plaintext'), 'retry.plaintext')
        }
    }
    if (mode === 'encrypted') {
        const encType = assertString(parsed.encType, 'encType')
        if (encType !== 'msg' && encType !== 'pkmsg' && encType !== 'skmsg') {
            throw new Error(`invalid retry encrypted encType: ${encType}`)
        }
        return {
            mode,
            to: assertString(parsed.to, 'to'),
            type: assertString(parsed.type, 'type'),
            encType,
            ciphertext: base64ToBytes(
                assertString(parsed.ciphertext, 'ciphertext'),
                'retry.ciphertext'
            ),
            participant:
                parsed.participant === undefined
                    ? undefined
                    : assertString(parsed.participant, 'participant')
        }
    }
    if (mode === 'opaque_node') {
        return {
            mode,
            node: base64ToBytes(assertString(parsed.node, 'node'), 'retry.node')
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
    if (RETRY_STATE_RANK[left] >= RETRY_STATE_RANK[right]) {
        return left
    }
    return right
}
