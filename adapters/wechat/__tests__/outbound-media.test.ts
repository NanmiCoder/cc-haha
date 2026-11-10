import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectWechatMedia, extractWechatDeliverables, loadWechatOutboundMedia } from '../outbound-media.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-outbound-'))
  roots.push(root)
  const project = path.join(root, 'project')
  await fs.mkdir(project)
  const file = path.join(project, 'report with spaces.txt')
  await fs.writeFile(file, 'report')
  return { root, project, file }
}

async function canCreateDirectoryLink(): Promise<boolean> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-link-probe-'))
  try {
    await fs.mkdir(path.join(root, 'target'))
    await fs.symlink(path.join(root, 'target'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
const directoryLinksSupported = await canCreateDirectoryLink()

describe('WeChat outbound project files', () => {
  it('recognizes bracket file markers without interpreting code or ordinary link labels', () => {
    const windowsPath = String.raw`C:\project\output\音频 100%20.mp3`
    const text = `[file:${windowsPath}]\n[file:/project/audio.wav]\n[file:///project/report.pdf]\n`
      + '`[file:/private/inline.mp3]`\n```text\n[file:/private/fenced.mp3]\n```\n'
      + '[file:/private/link-label.mp3](https://example.com)\n[source](/project/code.ts)\n'
      + '[label [file:/private/nested.mp3]](https://example.com)'
    expect(extractWechatDeliverables(text)).toEqual([windowsPath, '/project/audio.wav', 'file:///project/report.pdf'])
  })
  it('reads relative, quoted, and file URI paths as bounded snapshots', async () => {
    const { project, file } = await fixture()
    for (const target of ['report with spaces.txt', `"${file}"`, pathToFileURL(file).href]) {
      const loaded = await loadWechatOutboundMedia(target, project)
      expect(loaded.buffer.toString()).toBe('report')
      expect(loaded.kind).toBe('file')
      expect(loaded.fileName).toBe('report with spaces.txt')
    }
  })
  it('rejects outside roots, URLs, empty files and directories', async () => {
    const { project, root } = await fixture()
    await fs.writeFile(path.join(root, 'private.txt'), 'not a project artifact')
    await fs.writeFile(path.join(project, 'empty'), '')
    for (const target of ['../private.txt', 'https://example.com/file', '.', 'empty']) {
      await expect(loadWechatOutboundMedia(target, project)).rejects.toThrow()
    }
  })
  it.skipIf(!directoryLinksSupported)('rejects a directory symlink/junction escape', async () => {
    const { project, root } = await fixture()
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    await fs.symlink(outside, path.join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(loadWechatOutboundMedia('link/secret.txt', project)).rejects.toThrow('项目目录')
  })
  it('rejects oversized files before reading', async () => {
    const { project } = await fixture()
    const handle = await fs.open(path.join(project, 'huge.bin'), 'w')
    await handle.truncate(30 * 1024 * 1024 + 1)
    await handle.close()
    await expect(loadWechatOutboundMedia('huge.bin', project)).rejects.toThrow('30 MiB')
  })
  it('detects bytes rather than trusting an image extension', () => {
    expect(detectWechatMedia(Buffer.from('not an image')).kind).toBe('file')
    expect(detectWechatMedia(Buffer.from([0xff, 0xd8, 0xff, 0xd9])).mimeType).toBe('image/jpeg')
    const video = Buffer.alloc(16)
    video.write('ftypisom', 4)
    expect(detectWechatMedia(video).kind).toBe('video')
  })
  it('ignores ordinary code citations, code blocks and remote links; deduplicates deliverables', () => {
    const text = '[source](/project/a.ts) ![image](</project/a b.png>) [report](file:///project/report.pdf)\n' +
      '```md\n![secret](/private/key.png)\n```\n`![inline](/private/key.png)`\n![remote](https://example.com/a.png)\n[again](file:///project/report.pdf)'
    expect(extractWechatDeliverables(text)).toEqual(['/project/a b.png', 'file:///project/report.pdf'])
  })
  it('honors cancellation before reading', async () => {
    const { project, file } = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(loadWechatOutboundMedia(file, project, controller.signal)).rejects.toThrow()
  })
  it('decodes Markdown image destinations once without changing literal command paths', async () => {
    const { project } = await fixture()
    const name = '图表 100%20.png'
    await fs.writeFile(path.join(project, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const targets = extractWechatDeliverables(`![chart](${encodeURIComponent(name)})`)
    expect(targets).toEqual([name])
    expect((await loadWechatOutboundMedia(targets[0]!, project)).fileName).toBe(name)
    expect((await loadWechatOutboundMedia(name, project)).fileName).toBe(name)
    expect(extractWechatDeliverables('![literal](100%.png)')).toEqual(['100%.png'])
  })
})
