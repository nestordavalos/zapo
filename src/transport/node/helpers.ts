import type { BinaryNode } from '@transport/types'
import { toBytesView } from '@util/bytes'

const TEXT_ENCODER = new TextEncoder()

export function getNodeChildren(node: BinaryNode): readonly BinaryNode[] {
    if (!Array.isArray(node.content)) {
        return []
    }
    return node.content
}

export function findNodeChild(node: BinaryNode, tag: string): BinaryNode | undefined {
    const children = getNodeChildren(node)
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index]
        if (child.tag === tag) {
            return child
        }
    }
    return undefined
}

export function getFirstNodeChild(node: BinaryNode): BinaryNode | undefined {
    const children = getNodeChildren(node)
    if (children.length === 0) {
        return undefined
    }
    return children[0]
}

export function getNodeChildrenByTag(node: BinaryNode, tag: string): readonly BinaryNode[] {
    const children = getNodeChildren(node)
    const out: BinaryNode[] = []
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index]
        if (child.tag === tag) {
            out.push(child)
        }
    }
    return out
}

export function hasNodeChild(node: BinaryNode, tag: string): boolean {
    return findNodeChild(node, tag) !== undefined
}

export function asNodeBytes(value: BinaryNode['content'], field: string): Uint8Array {
    if (value instanceof Uint8Array) {
        return value
    }
    if (typeof value === 'string') {
        return TEXT_ENCODER.encode(value)
    }
    throw new Error(`node ${field} has no binary content`)
}

export function decodeBinaryNodeContent(value: BinaryNode['content'], field: string): Uint8Array {
    if (value === null || value === undefined) {
        throw new Error(`missing binary node content for ${field}`)
    }
    if (typeof value === 'string') {
        return toBytesView(Buffer.from(value, 'base64'))
    }
    if (value instanceof Uint8Array) {
        return value
    }
    throw new Error(`missing binary node content for ${field}`)
}
