import assert from 'node:assert/strict'
import test from 'node:test'

import { describeAckNode, isAckOrReceiptNode, isNegativeAckNode, isRetryableNegativeAck } from '@message/ack'
import { isSendMediaMessage, resolveMessageTypeAttr } from '@message/content'
import { unwrapDeviceSentMessage, wrapDeviceSentMessage } from '@message/device-sent'
import { unpadPkcs7, writeRandomPadMax16 } from '@message/padding'
import { computePhashV2 } from '@message/phash'

test('ack helpers classify receipt and retryability correctly', () => {
    const ackNode = { tag: 'ack', attrs: { id: '1', type: 'error', code: '500' } }
    const receiptNode = { tag: 'receipt', attrs: { id: '2' } }

    assert.equal(isAckOrReceiptNode(ackNode), true)
    assert.equal(isAckOrReceiptNode(receiptNode), true)
    assert.equal(isNegativeAckNode(ackNode), true)
    assert.equal(isRetryableNegativeAck(ackNode), true)
    assert.match(describeAckNode(ackNode), /id=1/)
})

test('content helpers detect media payload and resolve message type', () => {
    assert.equal(isSendMediaMessage({ type: 'image', media: new Uint8Array([1]), mimetype: 'x' }), true)
    assert.equal(isSendMediaMessage({}), false)

    assert.equal(resolveMessageTypeAttr({ reactionMessage: {} }), 'reaction')
    assert.equal(resolveMessageTypeAttr({ imageMessage: {} }), 'media')
    assert.equal(resolveMessageTypeAttr({ conversation: 'text' }), 'text')
})

test('device-sent wrapping preserves context and unwrap restores nested payload', () => {
    const wrapped = wrapDeviceSentMessage(
        {
            conversation: 'hello',
            messageContextInfo: {}
        },
        '5511@s.whatsapp.net'
    )

    assert.ok(wrapped.deviceSentMessage)
    const unwrapped = unwrapDeviceSentMessage(wrapped)
    assert.ok(unwrapped)
    assert.equal(unwrapped?.conversation, 'hello')
    assert.ok(unwrapped?.messageContextInfo)

    assert.equal(unwrapDeviceSentMessage({ conversation: 'x' }), null)
})

test('padding and phash generation cover success and edge paths', async () => {
    const input = new Uint8Array([1, 2, 3])
    const padded = await writeRandomPadMax16(input)
    assert.ok(padded.length > input.length)

    const unpadded = unpadPkcs7(new Uint8Array([10, 11, 2, 2]))
    assert.deepEqual(unpadded, new Uint8Array([10, 11]))
    assert.throws(() => unpadPkcs7(new Uint8Array([])), /empty bytes/)

    const hash = await computePhashV2(['5511:0@c.us', '5511:2@s.whatsapp.net'])
    assert.match(hash, /^2:/)
})
