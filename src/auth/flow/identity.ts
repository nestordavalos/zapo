import { HOST_DOMAIN } from './constants'

export function parsePhoneJid(input: string): string {
    const digits = input.replace(/\D+/g, '')
    if (!digits) {
        throw new Error('phone number is empty after normalization')
    }
    return `${digits}@${HOST_DOMAIN}`
}

export function getLoginIdentity(meJid: string): {
    readonly username: number
    readonly device: number
} {
    const atIndex = meJid.indexOf('@')
    if (atIndex <= 0) {
        throw new Error(`invalid meJid ${meJid}`)
    }
    const idPart = meJid.slice(0, atIndex)
    const [userAndAgent, devicePart = '0'] = idPart.split(':')
    const userPart = userAndAgent.split('.')[0]
    const username = Number.parseInt(userPart, 10)
    const device = Number.parseInt(devicePart, 10)
    if (!Number.isSafeInteger(username) || username <= 0) {
        throw new Error(`invalid numeric username from ${meJid}`)
    }
    if (!Number.isSafeInteger(device) || device < 0) {
        throw new Error(`invalid device from ${meJid}`)
    }
    return { username, device }
}
