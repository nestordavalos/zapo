import { sha256 } from '@crypto/core'
import { splitJid } from '@protocol/jid'
import { bytesToBase64, TEXT_ENCODER } from '@util/bytes'

export async function computePhashV2(participants: readonly string[]): Promise<string> {
    if (participants.length === 0) {
        return '2:'
    }

    const canonical = participants.map((participant) => toPhashCanonicalWid(participant))
    const joined = canonical.sort().join('')
    const digest = await sha256(TEXT_ENCODER.encode(joined))
    return `2:${bytesToBase64(digest.subarray(0, 6))}`
}

function toPhashCanonicalWid(jid: string): string {
    const { user, server } = splitJid(jid)
    const normalizedServer = server === 'c.us' ? 's.whatsapp.net' : server

    const colonIndex = user.indexOf(':')
    const userWithOptionalAgent = colonIndex >= 0 ? user.slice(0, colonIndex) : user
    const baseUser = userWithOptionalAgent.endsWith('.0')
        ? userWithOptionalAgent.slice(0, userWithOptionalAgent.length - 2)
        : userWithOptionalAgent
    const deviceRaw = colonIndex >= 0 ? user.slice(colonIndex + 1) : '0'
    const device = Number.parseInt(deviceRaw, 10)
    const normalizedDevice = Number.isSafeInteger(device) && device >= 0 ? device : 0

    return `${baseUser}.0:${normalizedDevice}@${normalizedServer}`
}
