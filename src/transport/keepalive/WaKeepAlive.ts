import type { Logger } from '../../infra/log/types'
import type { BinaryNode } from '../../transport/types'
import { toError } from '../../util/errors'
import type { WaComms } from '../WaComms'

import {
    DEFAULT_DEAD_SOCKET_TIMEOUT_MS,
    DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    DEFAULT_HOST_DOMAIN
} from './constants'
import type { WaKeepAliveOptions } from './types'

export class WaKeepAlive {
    private readonly logger: Logger
    private readonly nodeOrchestrator: WaKeepAliveOptions['nodeOrchestrator']
    private readonly getCommsFn: () => WaComms | null
    private readonly intervalMs: number
    private readonly timeoutMs: number
    private readonly hostDomain: string
    private timer: NodeJS.Timeout | null
    private generation: number
    private inFlight: boolean

    public constructor(options: WaKeepAliveOptions) {
        this.logger = options.logger
        this.nodeOrchestrator = options.nodeOrchestrator
        this.getCommsFn = options.getComms
        this.intervalMs = options.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
        this.timeoutMs = options.timeoutMs ?? DEFAULT_DEAD_SOCKET_TIMEOUT_MS
        this.hostDomain = options.hostDomain ?? DEFAULT_HOST_DOMAIN
        this.timer = null
        this.generation = 0
        this.inFlight = false
    }

    public start(): void {
        this.logger.info('keepalive start', {
            intervalMs: this.intervalMs,
            timeoutMs: this.timeoutMs
        })
        this.generation += 1
        this.inFlight = false
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        this.schedule(this.generation)
    }

    public stop(): void {
        this.logger.info('keepalive stop')
        this.generation += 1
        this.inFlight = false
        if (!this.timer) {
            return
        }
        clearTimeout(this.timer)
        this.timer = null
    }

    private schedule(generation: number): void {
        if (generation !== this.generation) {
            return
        }
        if (this.timer) {
            clearTimeout(this.timer)
        }
        this.timer = setTimeout(() => {
            this.timer = null
            void this.run(generation)
        }, this.intervalMs)
        this.logger.trace('keepalive scheduled', { generation, inMs: this.intervalMs })
    }

    private async run(generation: number): Promise<void> {
        if (generation !== this.generation) {
            return
        }

        const comms = this.getCommsFn()
        if (!comms || !comms.getCommsState().connected) {
            this.logger.trace('keepalive skipped: comms not connected')
            this.schedule(generation)
            return
        }

        if (this.inFlight || this.nodeOrchestrator.hasPending()) {
            this.logger.trace('keepalive skipped: in-flight or pending queries', {
                inFlight: this.inFlight,
                pendingQueries: this.nodeOrchestrator.hasPending()
            })
            this.schedule(generation)
            return
        }

        this.inFlight = true
        const startedAt = Date.now()
        try {
            const pingNode: BinaryNode = {
                tag: 'iq',
                attrs: {
                    to: this.hostDomain,
                    type: 'get',
                    xmlns: 'w:p'
                }
            }
            await this.nodeOrchestrator.query(pingNode, this.timeoutMs)
            this.logger.debug('keepalive ping success', {
                latencyMs: Date.now() - startedAt
            })
        } catch (error) {
            this.logger.warn('keepalive ping failed, reconnecting socket', {
                message: toError(error).message
            })
            try {
                await comms.closeSocketAndResume()
            } catch (resumeError) {
                this.logger.warn('keepalive reconnect failed', {
                    message: toError(resumeError).message
                })
            }
        } finally {
            this.inFlight = false
        }

        this.schedule(generation)
    }
}
