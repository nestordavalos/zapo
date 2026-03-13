import { WA_DEFAULTS } from '@protocol/defaults'
import { WA_XMLNS } from '@protocol/nodes'
import { buildIqNode } from '@transport/node/query'
import type { BinaryNode } from '@transport/types'

interface BuildCreateGroupIqInput {
    readonly subject: string
    readonly participants: readonly string[]
    readonly description?: string
}

export function buildCreateGroupIq(input: BuildCreateGroupIqInput): BinaryNode {
    const children: BinaryNode[] = input.participants.map((jid) => ({
        tag: 'participant',
        attrs: { jid }
    }))

    if (input.description) {
        children.push({
            tag: 'description',
            attrs: { id: `${Date.now()}` },
            content: [{ tag: 'body', attrs: {}, content: input.description }]
        })
    }

    return buildIqNode('set', WA_DEFAULTS.GROUP_SERVER, WA_XMLNS.GROUPS, [
        {
            tag: 'create',
            attrs: { subject: input.subject },
            content: children
        }
    ])
}

type GroupParticipantAction = 'add' | 'remove' | 'promote' | 'demote'

interface BuildGroupParticipantChangeIqInput {
    readonly groupJid: string
    readonly action: GroupParticipantAction
    readonly participants: readonly string[]
}

export function buildGroupParticipantChangeIq(
    input: BuildGroupParticipantChangeIqInput
): BinaryNode {
    return buildIqNode('set', input.groupJid, WA_XMLNS.GROUPS, [
        {
            tag: input.action,
            attrs: {},
            content: input.participants.map((jid) => ({
                tag: 'participant',
                attrs: { jid }
            }))
        }
    ])
}

export function buildLeaveGroupIq(groupJids: readonly string[]): BinaryNode {
    return buildIqNode('set', WA_DEFAULTS.GROUP_SERVER, WA_XMLNS.GROUPS, [
        {
            tag: 'leave',
            attrs: {},
            content: groupJids.map((jid) => ({
                tag: 'group',
                attrs: { id: jid }
            }))
        }
    ])
}
