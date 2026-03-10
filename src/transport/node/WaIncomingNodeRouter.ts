import type { BinaryNode } from '../../transport/types'

import type {
    WaIncomingNodeRouterOptions,
    WaIqSetNodeHandler,
    WaMessageNodeHandler,
    WaNotificationNodeHandler
} from './types'

export class WaIncomingNodeRouter {
    private readonly nodeOrchestrator: WaIncomingNodeRouterOptions['nodeOrchestrator']
    private readonly iqSetHandlers: readonly WaIqSetNodeHandler[]
    private readonly notificationHandlers: readonly WaNotificationNodeHandler[]
    private readonly messageHandlers: readonly WaMessageNodeHandler[]

    public constructor(options: WaIncomingNodeRouterOptions) {
        this.nodeOrchestrator = options.nodeOrchestrator
        this.iqSetHandlers = options.iqSetHandlers ?? []
        this.notificationHandlers = options.notificationHandlers ?? []
        this.messageHandlers = options.messageHandlers ?? []
    }

    public async dispatch(node: BinaryNode): Promise<boolean> {
        if (this.nodeOrchestrator.tryResolvePending(node)) {
            return true
        }

        const genericHandled = await this.nodeOrchestrator.handleIncomingNode(node)
        if (genericHandled) {
            return true
        }

        if (node.tag === 'iq') {
            if (node.attrs.type === 'set') {
                for (const handleIqSet of this.iqSetHandlers) {
                    if (await handleIqSet(node)) {
                        return true
                    }
                }
            }
            return false
        }

        if (node.tag === 'notification') {
            for (const handleNotification of this.notificationHandlers) {
                if (await handleNotification(node)) {
                    return true
                }
            }
            return false
        }

        if (node.tag === 'message') {
            for (const handleMessage of this.messageHandlers) {
                if (await handleMessage(node)) {
                    return true
                }
            }
        }
        return false
    }
}
