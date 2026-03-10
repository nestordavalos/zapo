import type { LogLevel, Logger } from '@infra/log/types'

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50
}

export class ConsoleLogger implements Logger {
    public readonly level: LogLevel

    public constructor(level: LogLevel = 'info') {
        this.level = level
    }

    public trace(message: string, context?: Record<string, unknown>): void {
        if (this.canLog('trace')) {
            console.debug(message, context)
        }
    }

    public debug(message: string, context?: Record<string, unknown>): void {
        if (this.canLog('debug')) {
            console.debug(message, context)
        }
    }

    public info(message: string, context?: Record<string, unknown>): void {
        if (this.canLog('info')) {
            console.info(message, context)
        }
    }

    public warn(message: string, context?: Record<string, unknown>): void {
        if (this.canLog('warn')) {
            console.warn(message, context)
        }
    }

    public error(message: string, context?: Record<string, unknown>): void {
        if (this.canLog('error')) {
            console.error(message, context)
        }
    }

    private canLog(level: LogLevel): boolean {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level]
    }
}
