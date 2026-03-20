import type { BinaryNode } from '@transport/types'
import { base64ToBytesChecked, TEXT_ENCODER } from '@util/bytes'

export function getNodeChildren(node: BinaryNode): readonly BinaryNode[] {
    return Array.isArray(node.content) ? node.content : []
}

export function findNodeChild(node: BinaryNode, tag: string): BinaryNode | undefined {
    return getNodeChildren(node).find((child) => child.tag === tag)
}

export function getFirstNodeChild(node: BinaryNode): BinaryNode | undefined {
    return getNodeChildren(node)[0]
}

export function getNodeChildrenByTag(node: BinaryNode, tag: string): readonly BinaryNode[] {
    return getNodeChildren(node).filter((child) => child.tag === tag)
}

export function hasNodeChild(node: BinaryNode, tag: string): boolean {
    return findNodeChild(node, tag) !== undefined
}

export function decodeNodeContentUtf8OrBytes(
    value: BinaryNode['content'],
    field: string
): Uint8Array {
    if (value instanceof Uint8Array) {
        return value
    }
    if (typeof value === 'string') {
        return TEXT_ENCODER.encode(value)
    }
    throw new Error(`node ${field} has no binary content`)
}

export function decodeNodeContentBase64OrBytes(
    value: BinaryNode['content'],
    field: string
): Uint8Array {
    if (value === null || value === undefined) {
        throw new Error(`missing binary node content for ${field}`)
    }
    if (typeof value === 'string') {
        return base64ToBytesChecked(value, field)
    }
    if (value instanceof Uint8Array) {
        return value
    }
    throw new Error(`missing binary node content for ${field}`)
}

export function formatNodeIdPrefixFromSeed(seed: Uint8Array): string {
    const left = ((seed[0] << 8) | seed[1]) >>> 0
    const right = ((seed[2] << 8) | seed[3]) >>> 0
    return `${left}.${right}-`
}
