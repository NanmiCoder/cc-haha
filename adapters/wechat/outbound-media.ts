import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'
import { FILE_MAX_BYTES, IMAGE_MAX_BYTES } from '../common/attachment/attachment-limits.js'

export type WechatOutboundMedia = {
  kind: 'image' | 'file' | 'video'
  buffer: Buffer
  fileName: string
  mimeType: string
}

// Parse the model's explicit [file:C:\...] shorthand as an inline token, so
// code fences/codespans remain inert and Windows backslashes stay literal.
const deliverableMarkdown = new Marked({ extensions: [{
  name: 'wechatFile',
  level: 'inline',
  start: source => source.indexOf('[file:'),
  tokenizer(source) {
    if (this.lexer.state.inLink) return
    const match = /^\[file:([^\]\r\n]+)\]/.exec(source)
    if (!match || source[match[0].length] === '(' || source[match[0].length] === '[') return
    const target = match[1]!.trim()
    if (!target) return
    return { type: 'wechatFile', raw: match[0], target: target.startsWith('//') ? `file:${target}` : target }
  },
}] })

/** Ordinary source-code citations are not upload requests. Images and explicit
 * file: links/markers are deliverables; fenced/inline code is never traversed. */
export function extractWechatDeliverables(text: string): string[] {
  const targets = new Set<string>()
  deliverableMarkdown.walkTokens(deliverableMarkdown.lexer(text), (token) => {
    if (token.type === 'wechatFile') {
      if (targets.size < 5) targets.add((token as { target: string }).target)
      return
    }
    if (token.type !== 'link' && token.type !== 'image') return
    const href = token.href
    if (!href || href.includes('#') || href.startsWith('data:')) return
    if (token.type === 'link' && !href.startsWith('file:')) return
    if (/^https?:/i.test(href)) return
    // Markdown destinations are URL-encoded; command paths remain literal.
    // file: URLs are decoded once by fileURLToPath at the read boundary.
    let target = href
    if (!href.startsWith('file:')) {
      try { target = decodeURIComponent(href) } catch { /* Keep literal percent signs in local filenames. */ }
    }
    if (targets.size < 5) targets.add(target)
  })
  return [...targets]
}

export function detectWechatMedia(buffer: Buffer): Pick<WechatOutboundMedia, 'kind' | 'mimeType'> {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: 'image', mimeType: 'image/png' }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { kind: 'image', mimeType: 'image/jpeg' }
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return { kind: 'image', mimeType: 'image/gif' }
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { kind: 'image', mimeType: 'image/webp' }
  // Only known MP4 brands use a video message. Other formats remain files.
  if (buffer.subarray(4, 8).toString() === 'ftyp' && /^(isom|iso2|mp41|mp42|avc1|M4V )$/.test(buffer.subarray(8, 12).toString())) return { kind: 'video', mimeType: 'video/mp4' }
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return { kind: 'file', mimeType: 'audio/wav' }
  return { kind: 'file', mimeType: 'application/octet-stream' }
}

/** Read once into a bounded snapshot. Only the current session's real root is
 * permitted; do not fetch remote URLs or let a symlink escape that root. */
export async function loadWechatOutboundMedia(target: string, workDir: string, signal?: AbortSignal): Promise<WechatOutboundMedia> {
  signal?.throwIfAborted()
  let source = target.trim()
  if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) source = source.slice(1, -1)
  if (source.startsWith('file:')) {
    const url = new URL(source)
    if (url.host || url.search || url.hash) throw new Error('只支持当前项目中的本地文件')
    source = fileURLToPath(url)
  }
  if (!source || /^(?:[a-z]+:\/\/|\\\\|\/\/)/i.test(source) || source.includes('\0')) throw new Error('只支持当前项目中的本地文件')
  const root = await fs.realpath(workDir)
  const resolved = await fs.realpath(path.resolve(root, source))
  const relative = path.relative(root, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('文件不在当前会话的项目目录内')
  const handle = await fs.open(resolved, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0) throw new Error('请选择非空普通文件')
    if (stat.size > FILE_MAX_BYTES) throw new Error('文件超过 30 MiB 上限')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted()
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > FILE_MAX_BYTES) throw new Error('文件超过 30 MiB 上限')
      chunks.push(bytes)
    }
    const buffer = Buffer.concat(chunks)
    const detected = detectWechatMedia(buffer)
    if (detected.kind === 'image' && buffer.length > IMAGE_MAX_BYTES) throw new Error('图片超过 10 MiB 上限')
    return { ...detected, buffer, fileName: path.basename(resolved) }
  } finally {
    await handle.close()
  }
}
