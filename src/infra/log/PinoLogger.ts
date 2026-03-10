import type { LogLevel, Logger } from './types'

type PinoLikeLogger = {
    level: string
    trace: (...args: unknown[]) => void
    debug: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
}

type PinoFactory = (options?: Readonly<Record<string, unknown>>) => PinoLikeLogger

export interface PinoLoggerOptions {
    readonly level?: LogLevel
    readonly name?: string
    readonly base?: Readonly<Record<string, unknown>> | null
    readonly pinoOptions?: Readonly<Record<string, unknown>>
    readonly pretty?:
        | boolean
        | {
              readonly options?: Readonly<Record<string, unknown>>
          }
}

const PINO_MODULE = 'pino'
const PINO_PRETTY_MODULE = 'pino-pretty'

async function importModule(moduleName: string): Promise<unknown> {
    return import(moduleName)
}

function asPinoFactory(loaded: unknown): PinoFactory {
    if (typeof loaded === 'function') {
        return loaded as PinoFactory
    }
    if (loaded && typeof loaded === 'object') {
        const candidate = (loaded as { default?: unknown }).default
        if (typeof candidate === 'function') {
            return candidate as PinoFactory
        }
    }
    throw new Error('invalid pino module export')
}

async function loadPinoFactory(): Promise<PinoFactory> {
    try {
        const loaded = await importModule(PINO_MODULE)
        return asPinoFactory(loaded)
    } catch {
        throw new Error(
            'optional dependency "pino" is not installed. Install with: npm i pino'
        )
    }
}

async function ensurePinoPrettyInstalled(): Promise<void> {
    try {
        await importModule(PINO_PRETTY_MODULE)
    } catch {
        throw new Error(
            'optional dependency "pino-pretty" is not installed. Install with: npm i -D pino-pretty'
        )
    }
}

function writeLog(
    logger: PinoLikeLogger,
    method: keyof Pick<PinoLikeLogger, 'trace' | 'debug' | 'info' | 'warn' | 'error'>,
    message: string,
    context?: Readonly<Record<string, unknown>>
): void {
    if (!context || Object.keys(context).length === 0) {
        logger[method](message)
        return
    }
    logger[method](context, message)
}

export class PinoLogger implements Logger {
    public readonly level: LogLevel
    private readonly logger: PinoLikeLogger

    public constructor(logger: PinoLikeLogger, level: LogLevel = 'info') {
        this.logger = logger
        this.level = level
        this.logger.level = level
    }

    public trace(message: string, context?: Readonly<Record<string, unknown>>): void {
        writeLog(this.logger, 'trace', message, context)
    }

    public debug(message: string, context?: Readonly<Record<string, unknown>>): void {
        writeLog(this.logger, 'debug', message, context)
    }

    public info(message: string, context?: Readonly<Record<string, unknown>>): void {
        writeLog(this.logger, 'info', message, context)
    }

    public warn(message: string, context?: Readonly<Record<string, unknown>>): void {
        writeLog(this.logger, 'warn', message, context)
    }

    public error(message: string, context?: Readonly<Record<string, unknown>>): void {
        writeLog(this.logger, 'error', message, context)
    }
}

export async function createPinoLogger(options: PinoLoggerOptions = {}): Promise<PinoLogger> {
    const level = options.level ?? 'info'
    if (options.pretty) {
        await ensurePinoPrettyInstalled()
    }

    const pino = await loadPinoFactory()
    const pinoOptions: Record<string, unknown> = {
        ...(options.pinoOptions ?? {}),
        level
    }

    if (options.name) {
        pinoOptions.name = options.name
    }
    if (options.base !== undefined) {
        pinoOptions.base = options.base
    }
    if (options.pretty) {
        const prettyOptions = typeof options.pretty === 'object' ? options.pretty.options : undefined
        pinoOptions.transport = prettyOptions
            ? {
                  target: PINO_PRETTY_MODULE,
                  options: prettyOptions
              }
            : {
                  target: PINO_PRETTY_MODULE
              }
    }

    const pinoLogger = pino(pinoOptions)
    return new PinoLogger(pinoLogger, level)
}
