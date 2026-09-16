import { marked, type Token, type Tokens } from 'marked'
import { Schema, type Mark, type Node as MarkdownNode } from 'prosemirror-model'

// Per-document source ids never leave this editor. They preserve untouched blocks
// byte-for-byte instead of round-tripping the whole file through an HTML converter.
const sourceAttrs = { sourceId: { default: null } }
export const remoteMarkdownSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: sourceAttrs, parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    heading: {
      group: 'block', content: 'inline*', defining: true, attrs: { ...sourceAttrs, level: { default: 1 } },
      parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: node => [`h${node.attrs.level}`, 0],
    },
    blockquote: { group: 'block', content: 'block+', defining: true, attrs: sourceAttrs, parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
    bullet_list: { group: 'block', content: 'list_item+', attrs: sourceAttrs, parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
    ordered_list: {
      group: 'block', content: 'list_item+', attrs: { ...sourceAttrs, order: { default: 1 } },
      parseDOM: [{ tag: 'ol', getAttrs: dom => ({ order: Number(dom.getAttribute('start') ?? 1) || 1 }) }],
      toDOM: node => ['ol', { start: node.attrs.order }, 0],
    },
    list_item: {
      content: 'paragraph block*', defining: true,
      attrs: { task: { default: false }, checked: { default: false } },
      parseDOM: [{ tag: 'li' }],
      toDOM: node => ['li', { 'data-remote-task': node.attrs.task ? String(node.attrs.checked) : null }, 0],
    },
    code_block: {
      group: 'block', content: 'text*', marks: '', code: true, defining: true,
      attrs: { ...sourceAttrs, language: { default: '' } },
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: node => ['pre', ['code', { 'data-language': node.attrs.language }, 0]],
    },
    horizontal_rule: { group: 'block', attrs: sourceAttrs, parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
    table: { group: 'block', content: 'table_row+', isolating: true, attrs: sourceAttrs, toDOM: () => ['table', ['tbody', 0]] },
    table_row: { content: 'table_cell+', toDOM: () => ['tr', 0] },
    table_cell: {
      content: 'inline*', isolating: true, attrs: { header: { default: false }, align: { default: null } },
      toDOM: node => [node.attrs.header ? 'th' : 'td', { 'data-align': node.attrs.align }, 0],
    },
    raw_block: {
      group: 'block', atom: true, attrs: { ...sourceAttrs, source: { default: '' } },
      // Raw HTML/frontmatter/extensions are inert text, not mounted HTML or hidden data.
      toDOM: node => ['pre', { 'data-remote-raw': '', contenteditable: 'false' }, node.attrs.source],
    },
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
    raw_inline: {
      inline: true, group: 'inline', atom: true, attrs: { source: { default: '' } },
      toDOM: node => ['span', { 'data-remote-raw': '', contenteditable: 'false' }, node.attrs.source],
    },
    image: {
      inline: true, group: 'inline', atom: true, attrs: { source: { default: '' }, alt: { default: '' } },
      // Opening a remote Markdown file must not make external image requests.
      toDOM: node => ['span', { 'data-remote-image': '', contenteditable: 'false' }, `🖼 ${node.attrs.alt}`],
    },
  },
  marks: {
    strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
    em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
    code: { code: true, parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
    strike: { parseDOM: [{ tag: 'del' }, { tag: 's' }], toDOM: () => ['del', 0] },
    link: {
      attrs: { href: {}, title: { default: null } }, inclusive: false,
      // Deliberately no href in the DOM; links remain editable without navigation.
      toDOM: node => ['span', { 'data-remote-link': '', title: node.attrs.title ?? node.attrs.href }, 0],
    },
  },
})
const schema = remoteMarkdownSchema
const text = (value: string, marks: readonly Mark[] = []) => value ? [schema.text(value, marks)] : []
function entities(value: string) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, encoded => {
    const names: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
    const named = names[encoded.toLowerCase()]
    if (named !== undefined) return named
    const numeric = encoded.slice(2, -1)
    const code = numeric[0]?.toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : encoded
  })
}
function inline(tokens: Token[], marks: readonly Mark[] = [], depth = 0): MarkdownNode[] {
  if (depth > 64) return text(tokens.map(token => token.raw).join(''), marks)
  return tokens.flatMap(token => {
    switch (token.type) {
      case 'strong': case 'em': case 'del': {
        const nested = token as Tokens.Strong
        const mark = schema.marks[token.type === 'del' ? 'strike' : token.type]!.create()
        return inline(nested.tokens, mark.addToSet(marks), depth + 1)
      }
      case 'link': {
        const link = token as Tokens.Link
        return inline(link.tokens, schema.marks.link!.create({ href: link.href, title: link.title }).addToSet(marks), depth + 1)
      }
      case 'codespan': return text((token as Tokens.Codespan).text, schema.marks.code!.create().addToSet(marks))
      case 'br': return [schema.nodes.hard_break!.create()]
      case 'image': return [schema.nodes.image!.create({ source: token.raw, alt: (token as Tokens.Image).text })]
      case 'html': return [schema.nodes.raw_inline!.create({ source: token.raw })]
      case 'text': case 'escape': {
        const value = token as Tokens.Text
        return value.tokens ? inline(value.tokens, marks, depth + 1) : text(entities(value.text), marks)
      }
      default: return [schema.nodes.raw_inline!.create({ source: token.raw })]
    }
  })
}
function block(token: Token, depth = 0): MarkdownNode {
  if (depth > 64) return schema.nodes.raw_block!.create({ source: token.raw })
  switch (token.type) {
    case 'heading': {
      const value = token as Tokens.Heading
      return schema.nodes.heading!.create({ level: value.depth }, inline(value.tokens))
    }
    case 'paragraph': case 'text': {
      const value = token as Tokens.Paragraph
      return schema.nodes.paragraph!.create(null, inline(value.tokens ?? marked.lexer(value.text).flatMap(item => (item as Tokens.Paragraph).tokens ?? [])))
    }
    case 'code': {
      const value = token as Tokens.Code
      return schema.nodes.code_block!.create({ language: value.lang ?? '' }, text(value.text))
    }
    case 'blockquote': {
      const content = (token as Tokens.Blockquote).tokens.filter(item => item.type !== 'space').map(item => block(item, depth + 1))
      return schema.nodes.blockquote!.create(null, content.length ? content : [schema.nodes.paragraph!.create()])
    }
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map(item => {
        const children = item.tokens.filter(value => value.type !== 'space').map(value => block(value, depth + 1))
        if (!children.length || children[0]!.type !== schema.nodes.paragraph) children.unshift(schema.nodes.paragraph!.create())
        return schema.nodes.list_item!.create({ task: item.task, checked: Boolean(item.checked) }, children)
      })
      return schema.nodes[list.ordered ? 'ordered_list' : 'bullet_list']!.create({ order: Number(list.start) || 1 }, items)
    }
    case 'table': {
      const table = token as Tokens.Table
      const row = (cells: Tokens.TableCell[], header: boolean) => schema.nodes.table_row!.create(null,
        cells.map((cell, index) => schema.nodes.table_cell!.create({ header, align: table.align[index] ?? null }, inline(cell.tokens))))
      return schema.nodes.table!.create(null, [row(table.header, true), ...table.rows.map(cells => row(cells, false))])
    }
    case 'hr': return schema.nodes.horizontal_rule!.create()
    default: return schema.nodes.raw_block!.create({ source: token.raw })
  }
}
function escape(value: string) { return value.replace(/&/g, '&amp;').replace(/[\\`*_{}\[\]<>#|~]/g, '\\$&') }
function inlineSource(node: MarkdownNode): string {
  const children: MarkdownNode[] = []
  node.forEach(child => { children.push(child) })
  const render = (items: MarkdownNode[], depth: number): string => {
    let out = ''
    for (let index = 0; index < items.length;) {
      const child = items[index]!
      const mark = child.marks[depth]
      if (!mark) {
        if (child.type === schema.nodes.raw_inline || child.type === schema.nodes.image) out += child.attrs.source
        else if (child.type === schema.nodes.hard_break) out += '  \n'
        else out += escape(child.text ?? '')
        index++
        continue
      }
      // Keep contiguous mark runs together: **a *b* c**, not adjacent closing
      // and opening delimiter runs that turn into extra nested emphasis.
      let end = index + 1
      while (end < items.length && items[end]!.marks[depth]?.eq(mark)) end++
      const group = items.slice(index, end)
      let value: string
      if (mark.type === schema.marks.code) {
        value = group.map(item => item.textContent).join('')
        // GFM splits table cells before parsing code spans, even inside backticks.
        if (node.type === schema.nodes.table_cell) value = value.replace(/\|/g, '\\|')
        const ticks = '`'.repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map(match => match[0].length + 1)))
        const padding = value.startsWith('`') || value.endsWith('`') || (/^ .* $/.test(value) && value.trim()) ? ' ' : ''
        value = `${ticks}${padding}${value}${padding}${ticks}`
      } else {
        value = render(group, depth + 1)
        if (mark.type === schema.marks.link) {
          const href = String(mark.attrs.href).replace(/>/g, '%3E').replace(/\n/g, '%0A')
          const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''
          value = `[${value}](<${href}>${title})`
        } else {
          const delimiter = mark.type === schema.marks.strong ? '**' : mark.type === schema.marks.em ? '*' : '~~'
          const parts = value.match(/^(\s*)([\s\S]*?)(\s*)$/)!
          value = parts[2] ? `${parts[1]}${delimiter}${parts[2]}${delimiter}${parts[3]}` : value
        }
      }
      out += value
      index = end
    }
    return out
  }
  return render(children, 0)
}
function blockSource(node: MarkdownNode): string {
  const children = () => { const result: string[] = []; node.forEach(child => result.push(blockSource(child))); return result.join('\n\n') }
  switch (node.type.name) {
    case 'paragraph': case 'table_cell': return inlineSource(node)
    case 'heading': return `${'#'.repeat(node.attrs.level)} ${inlineSource(node)}`
    case 'horizontal_rule': return '---'
    case 'raw_block': return node.attrs.source
    case 'code_block': {
      const fence = '`'.repeat(Math.max(3, ...[...node.textContent.matchAll(/`+/g)].map(match => match[0].length + 1)))
      return `${fence}${String(node.attrs.language).replace(/[\r\n]/g, '')}\n${node.textContent}\n${fence}`
    }
    case 'blockquote': return children().split('\n').map(line => `> ${line}`).join('\n')
    case 'bullet_list': case 'ordered_list': {
      const lines: string[] = []
      node.forEach((item, _offset, index) => {
        const marker = node.type.name === 'ordered_list' ? `${Number(node.attrs.order) + index}. ` : '- '
        const task = item.attrs.task ? (item.attrs.checked ? '[x] ' : '[ ] ') : ''
        const parts: string[] = []
        item.forEach(child => parts.push(blockSource(child)))
        const content = parts.join('\n\n').split('\n')
        lines.push(marker + task + content[0], ...content.slice(1).map(line => ' '.repeat(marker.length) + line))
      })
      return lines.join('\n')
    }
    case 'table': {
      const rows: string[] = []
      node.forEach((row, _offset, index) => {
        const cells: string[] = []
        row.forEach(cell => cells.push(inlineSource(cell).replace(/\n/g, '<br>')))
        rows.push(`| ${cells.join(' | ')} |`)
        if (index === 0) {
          const align: string[] = []
          row.forEach(cell => align.push(cell.attrs.align === 'center' ? ':---:' : cell.attrs.align === 'right' ? '---:' : cell.attrs.align === 'left' ? ':---' : '---'))
          rows.push(`| ${align.join(' | ')} |`)
        }
      })
      return rows.join('\n')
    }
    default: return children()
  }
}

export type RemoteMarkdownDocument = { doc: MarkdownNode; hasSourceBlocks: boolean; serialize: (doc: MarkdownNode) => string }
export function parseRemoteMarkdown(source: string): RemoteMarkdownDocument {
  const originals = new Map<number, { node: MarkdownNode; raw: string }>()
  const nodes: MarkdownNode[] = []
  // Marked normalizes CRLF. Map normalized offsets back to the original bytes.
  const offsets: number[] = []
  let normalized = ''
  for (let index = 0; index < source.length; index++) {
    offsets.push(index)
    if (source[index] === '\r') { normalized += '\n'; if (source[index + 1] === '\n') index++ }
    else normalized += source[index]
  }
  offsets.push(source.length)
  const rawRange = (start: number, end: number) => source.slice(offsets[start], offsets[end])
  let cursor = 0
  let sourceId = 0
  const add = (node: MarkdownNode, raw: string) => {
    const next = node.type.create({ ...node.attrs, sourceId: ++sourceId }, node.content, node.marks)
    nodes.push(next)
    originals.set(sourceId, { node: next, raw })
  }
  const gap = (value: string) => {
    if (!value) return
    const last = nodes.at(-1)
    if (!value.trim() && last) originals.get(last.attrs.sourceId)!.raw += value
    else add(schema.nodes.raw_block!.create({ source: value }), value)
  }
  const frontmatter = normalized.match(/^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/)
  if (frontmatter) { cursor = frontmatter[0].length; gap(rawRange(0, cursor)) }
  const body = normalized.slice(cursor)
  try {
    for (const token of marked.lexer(body, { gfm: true })) {
      if (token.type === 'space') continue
      const start = normalized.indexOf(token.raw, cursor)
      if (start < cursor) throw new Error('Markdown source offsets unavailable')
      gap(rawRange(cursor, start))
      const end = start + token.raw.length
      add(block(token), rawRange(start, end))
      cursor = end
    }
    gap(rawRange(cursor, normalized.length))
  } catch {
    nodes.length = 0
    originals.clear()
    add(schema.nodes.raw_block!.create({ source }), source)
  }
  if (!nodes.length) add(schema.nodes.paragraph!.create(), source)
  const doc = schema.nodes.doc!.create(null, nodes)
  let hasSourceBlocks = false
  doc.descendants(node => { if (node.type.name.startsWith('raw_')) hasSourceBlocks = true })
  return {
    doc, hasSourceBlocks,
    serialize(current) {
      if (current.eq(doc)) return source
      const chunks: string[] = []
      const defaultNewline = source.includes('\r\n') ? '\r\n' : '\n'
      current.forEach((node, _offset, index) => {
        const original = originals.get(node.attrs.sourceId)
        const newline = original?.raw.includes('\r\n') ? '\r\n' : defaultNewline
        const last = index === current.childCount - 1
        let chunk: string
        if (original && node.eq(original.node)) chunk = original.raw
        else {
          const body = blockSource(node).replace(/\n/g, newline)
          const suffix = original?.raw.match(/(?:\r?\n)*$/)?.[0] ?? (last ? '' : newline + newline)
          chunk = body + (suffix || (last ? '' : newline + newline))
        }
        if (!last) {
          const next = current.child(index + 1)
          const nextOriginal = originals.get(next.attrs.sourceId)
          const originalBoundary = original && nextOriginal
            && next.attrs.sourceId === node.attrs.sourceId + 1
            && node.type === original.node.type && next.type === nextOriginal.node.type
          // An unchanged EOF block has no separator to reuse when Enter appends
          // a new paragraph. Keep original boundaries; separate new ones explicitly.
          if (!originalBoundary) {
            const endings = chunk.match(/(?:\r\n|\n|\r)$/) ? (chunk.match(/(?:\r\n|\n|\r)+$/)![0].match(/\r\n|\n|\r/g)?.length ?? 0) : 0
            if (endings < 2) chunk += newline.repeat(2 - endings)
          }
        }
        chunks.push(chunk)
      })
      return chunks.join('')
    },
  }
}
