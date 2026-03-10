export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
    readonly level: LogLevel
    trace(message: string, context?: Readonly<Record<string, unknown>>): void
    debug(message: string, context?: Readonly<Record<string, unknown>>): void
    info(message: string, context?: Readonly<Record<string, unknown>>): void
    warn(message: string, context?: Readonly<Record<string, unknown>>): void
    error(message: string, context?: Readonly<Record<string, unknown>>): void
}
