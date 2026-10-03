import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../services/workspaceService.js'
import { handlePreviewFs } from '../api/previewFs.js'

// Boundary shapes behind "the card opens, but the pane says the file is missing":
// CJK directories, Unicode normalization, and a deliverable named without its folder.

const cleanupDirs: string[] = []

async function makeWorkDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-edge-'))
  cleanupDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('workspace file lookup edge cases', () => {
  it('reads a docx inside a CJK directory next to a hidden folder', async () => {
    const workDir = await makeWorkDir()
    const folder = path.join(workDir, '开题报告')
    await fs.mkdir(path.join(folder, '.workbuddy'), { recursive: true })
    await fs.writeFile(path.join(folder, '2.docx'), 'PK')
    const service = new WorkspaceService(async () => workDir)

    await expect(service.readFile('s1', '开题报告/2.docx')).resolves.toMatchObject({ state: 'ok', previewType: 'docx' })
    if (process.platform === 'win32') await expect(service.readFile('s1', '开题报告\\2.docx')).resolves.toMatchObject({ state: 'ok', previewType: 'docx' })
    const raw = await service.resolveRawFile('s1', '开题报告/2.docx')
    expect(raw.canonicalPath.endsWith('2.docx')).toBe(true)
  })

  it('finds a CJK-named file when the request uses the other Unicode normalization form', async () => {
    const workDir = await makeWorkDir()
    const name = '毕业设计（论文）开题报告 é.docx'
    await fs.writeFile(path.join(workDir, name.normalize('NFD')), 'PK')
    const service = new WorkspaceService(async () => workDir)

    // Models emit NFC; some file systems and tools persist NFD (and vice versa).
    const outcome = await service.readFile('s1', name.normalize('NFC'))
    expect(outcome.state).not.toBe('missing')
  })

  it('serves a CJK path through the URL-encoded preview route', async () => {
    const workDir = await makeWorkDir()
    await fs.mkdir(path.join(workDir, '图片'), { recursive: true })
    await fs.writeFile(path.join(workDir, '图片', '横幅 1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const url = new URL(`http://127.0.0.1/preview-fs/s1/${encodeURIComponent('图片')}/${encodeURIComponent('横幅 1.png')}`)

    const res = await handlePreviewFs(url, async () => workDir)
    expect(res.status).toBe(200)
  })

  it('reports a bare name as missing when the file lives in a subdirectory (baseline)', async () => {
    const workDir = await makeWorkDir()
    await fs.mkdir(path.join(workDir, 'docs', 'static'), { recursive: true })
    await fs.writeFile(path.join(workDir, 'docs', 'static', 'banner_sep.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const service = new WorkspaceService(async () => workDir)

    await expect(service.readFile('s1', 'banner_sep.png')).resolves.toMatchObject({ state: 'missing' })
    const res = await handlePreviewFs(new URL('http://127.0.0.1/preview-fs/s1/banner_sep.png'), async () => workDir)
    expect(res.status).toBe(404)
  })
})
