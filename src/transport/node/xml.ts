import type { BinaryNode } from '@transport/types'
import { bytesToBase64 } from '@util/bytes'

const XML_INDENT = '    '

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

function renderAttrs(attrs: BinaryNode['attrs']): string {
    const entries = Object.entries(attrs)
    if (entries.length === 0) {
        return ''
    }
    return entries.map(([key, value]) => ` ${key}='${escapeXml(value)}'`).join('')
}

function renderNode(node: BinaryNode, depth: number): string {
    const indent = XML_INDENT.repeat(depth)
    const attrs = renderAttrs(node.attrs)
    const content = node.content
    if (content === undefined) {
        return `${indent}<${node.tag}${attrs}/>`
    }
    if (typeof content === 'string') {
        return `${indent}<${node.tag}${attrs}>${escapeXml(content)}</${node.tag}>`
    }
    if (content instanceof Uint8Array) {
        return `${indent}<${node.tag}${attrs}>${bytesToBase64(content)}</${node.tag}>`
    }
    if (content.length === 0) {
        return `${indent}<${node.tag}${attrs}/>`
    }
    const children = content.map((child) => renderNode(child, depth + 1)).join('\n')
    return `${indent}<${node.tag}${attrs}>\n${children}\n${indent}</${node.tag}>`
}

export function formatBinaryNodeAsXml(node: BinaryNode): string {
    return renderNode(node, 0)
}
