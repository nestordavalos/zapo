import type { SignalAddress } from '../signal/types'

export function normalizeRecipientJid(to: string, userServer: string, groupServer: string): string {
    const input = to.trim()
    if (input.length === 0) {
        throw new Error('recipient cannot be empty')
    }
    if (input.includes('@')) {
        return input
    }

    if (input.includes('-')) {
        return `${input}@${groupServer}`
    }

    const digits = input.replace(/\D/g, '')
    if (digits.length === 0) {
        throw new Error(`invalid recipient: ${to}`)
    }
    return `${digits}@${userServer}`
}

export function isGroupJid(jid: string, groupServer: string): boolean {
    return jid.endsWith(`@${groupServer}`)
}

export function parseSignalAddressFromJid(jid: string): SignalAddress {
    const atIndex = jid.indexOf('@')
    if (atIndex < 1 || atIndex >= jid.length - 1) {
        throw new Error(`invalid jid: ${jid}`)
    }
    const local = jid.slice(0, atIndex)
    const server = jid.slice(atIndex + 1)
    const colonIndex = local.indexOf(':')
    if (colonIndex === -1) {
        return {
            user: local,
            server,
            device: 0
        }
    }
    const user = local.slice(0, colonIndex)
    const deviceRaw = local.slice(colonIndex + 1)
    const device = Number.parseInt(deviceRaw, 10)
    if (!Number.isFinite(device) || device < 0) {
        throw new Error(`invalid jid device: ${jid}`)
    }
    return {
        user,
        server,
        device
    }
}
