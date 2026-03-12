import { RETRY_REASON, type WaRetryReasonCode } from '@retry/constants'
import { toError } from '@util/primitives'

export function mapRetryReasonFromError(error: unknown): WaRetryReasonCode {
    const message = toError(error).message.toLowerCase()

    if (message.includes('no session') || message.includes('session not found')) {
        return RETRY_REASON.SignalErrorNoSession
    }
    if (message.includes('invalid key id')) {
        return RETRY_REASON.SignalErrorInvalidKeyId
    }
    if (message.includes('invalid key')) {
        return RETRY_REASON.SignalErrorInvalidKey
    }
    if (
        message.includes('invalid signal message') ||
        message.includes('invalid prekey signal message') ||
        message.includes('invalid sender key message')
    ) {
        return RETRY_REASON.SignalErrorInvalidMessage
    }
    if (message.includes('invalid signature')) {
        return RETRY_REASON.SignalErrorInvalidSignature
    }
    if (
        message.includes('too many messages in future') ||
        message.includes('future message')
    ) {
        return RETRY_REASON.SignalErrorFutureMessage
    }
    if (message.includes('invalid mac')) {
        return RETRY_REASON.SignalErrorBadMac
    }
    if (message.includes('invalid session')) {
        return RETRY_REASON.SignalErrorInvalidSession
    }
    if (message.includes('invalid message key')) {
        return RETRY_REASON.SignalErrorInvalidMsgKey
    }
    if (message.includes('broadcast') && message.includes('ephemeral')) {
        return RETRY_REASON.BadBroadcastEphemeralSetting
    }
    if (message.includes('unknown companion') || message.includes('unknown device')) {
        return RETRY_REASON.UnknownCompanionNoPrekey
    }
    if (message.includes('adv')) {
        return RETRY_REASON.AdvFailure
    }
    if (message.includes('status') && message.includes('revoke') && message.includes('delay')) {
        return RETRY_REASON.StatusRevokeDelay
    }
    return RETRY_REASON.UnknownError
}
