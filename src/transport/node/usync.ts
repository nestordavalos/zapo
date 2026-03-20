import { randomBytesAsync } from '@crypto'

import { formatNodeIdPrefixFromSeed } from './helpers'

interface WaUsyncIdState {
    prefix: string | null
    prefixPromise: Promise<string> | null
    counter: number
}

export type WaUsyncSidGenerator = () => Promise<string>

export function createUsyncSidGenerator(): WaUsyncSidGenerator {
    const state: WaUsyncIdState = {
        prefix: null,
        prefixPromise: null,
        counter: 1
    }

    return async () => {
        const prefix = await getUsyncPrefix(state)
        const sid = `${prefix}${state.counter}`
        state.counter += 1
        return sid
    }
}

async function getUsyncPrefix(state: WaUsyncIdState): Promise<string> {
    if (state.prefix) {
        return state.prefix
    }
    if (!state.prefixPromise) {
        state.prefixPromise = buildUsyncPrefix()
            .then((prefix) => {
                state.prefix = prefix
                return prefix
            })
            .finally(() => {
                state.prefixPromise = null
            })
    }
    return state.prefixPromise
}

async function buildUsyncPrefix(): Promise<string> {
    const seed = await randomBytesAsync(4)
    return formatNodeIdPrefixFromSeed(seed)
}
