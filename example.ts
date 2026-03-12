import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createPinoLogger, createStore, WaClient } from './dist'
import type { LogLevel } from './dist'

function resolveLogLevel(value: string | undefined): LogLevel {
    switch (value) {
        case 'trace':
        case 'debug':
        case 'info':
        case 'warn':
        case 'error':
            return value
        default:
            return 'info'
    }
}

async function main(): Promise<void> {
    const authPath = resolve(process.cwd(), '.auth', 'state.sqlite')
    await mkdir(dirname(authPath), { recursive: true })
    if (process.env.EXAMPLE_RESET_AUTH === '1') {
        await rm(authPath, { force: true })
        console.log(`[info] auth reset: ${authPath}`)
    }

    const logger = await createPinoLogger({
        level: resolveLogLevel('info'),
        pretty:
            process.env.EXAMPLE_PINO_PRETTY === '0'
                ? false
                : {
                      options: {
                          colorize: true,
                          translateTime: 'SYS:standard'
                      }
                  }
    })

    const sessionId = process.env.EXAMPLE_SESSION_ID ?? 'default'
    const store = createStore({
        sqlite: {
            path: authPath,
            driver: 'auto'
        }
    })

    const client = new WaClient(
        {
            store,
            sessionId,
            connectTimeoutMs: 15_000,
            deviceBrowser: 'Firefox',
            deviceOsDisplayName: 'Windows'
        },
        logger
    )

    const extractIncomingText = (
        message:
            | {
                  conversation?: string | null
                  extendedTextMessage?: { text?: string | null } | null
              }
            | null
            | undefined
    ): string | undefined => {
        if (!message) {
            return undefined
        }
        if (typeof message.conversation === 'string' && message.conversation.length > 0) {
            return message.conversation
        }
        const extendedText = message.extendedTextMessage?.text
        if (typeof extendedText === 'string' && extendedText.length > 0) {
            return extendedText
        }
        return undefined
    }

    client.on('connected', async () => {
        console.log('[connected]')
    })
    client.on('disconnected', () => {
        console.log('[disconnected]')
    })
    client.on('qr', (qr, ttlMs) => {
        console.log(`[qr] ttlMs=${ttlMs} value=${qr}`)
    })
    client.on('pairing_code', (code) => {
        console.log(`[pairing_code] ${code}`)
    })
    client.on('pairing_refresh', (forceManual) => {
        console.log(`[pairing_refresh] forceManual=${forceManual}`)
    })
    client.on('paired', (credentials) => {
        console.log(`[paired] meJid=${credentials.meJid ?? 'unknown'}`)
    })
    client.on('incoming_message', async (event) => {
        const text = extractIncomingText(event.message)
        console.log('[incoming_message] mensagem completa:')
        console.dir(event.message ?? event, { depth: null })
        if (!text || text.trim().toLowerCase() !== 'ping') {
            return
        }
        const to = event.from ?? event.senderJid
        if (!to) {
            console.log('[incoming_message] ping sem destino para responder')
            return
        }
        await client.sendMessage(to, {
            extendedTextMessage: {
                text: 'pong'
            }
        })
        console.log(`[incoming_message] pong enviado para ${to}`)
    })
    await client.connect()

    const autoExitMs = Number(process.env.EXAMPLE_EXIT_MS ?? '0')
    if (Number.isFinite(autoExitMs) && autoExitMs > 0) {
        setTimeout(() => {
            void shutdown(client, 0)
        }, autoExitMs)
    }

    process.on('SIGINT', () => {
        void shutdown(client, 0)
    })
    process.on('SIGTERM', () => {
        void shutdown(client, 0)
    })
}

async function shutdown(client: WaClient, code: number): Promise<void> {
    await client.disconnect().catch(() => undefined)
    process.exit(code)
}

void main().catch((error) => {
    console.error(error)
    process.exit(1)
})
