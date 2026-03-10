import { HOST_DOMAIN } from '../client.constants'

export function parsePhoneJid(input: string): string {
    const digits = input.replace(/\D+/g, '')
    if (!digits) {
        throw new Error('phone number is empty after normalization')
    }
    return `${digits}@${HOST_DOMAIN}`
}
