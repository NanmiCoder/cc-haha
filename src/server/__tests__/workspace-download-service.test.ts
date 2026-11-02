import { afterEach, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { MAX_WORKSPACE_DOWNLOAD_BYTES, WorkspaceService } from '../services/workspaceService.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

it('does not export a truncated prefix when the file grows beyond the cap after fstat', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-download-growth-'))
  directories.push(directory)
  const target = path.join(directory, 'growing.bin')
  await fs.writeFile(target, Buffer.from([1, 2, 3]))
  const originalOpen = fs.open
  let closed = false
  const open = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args)
    const originalStat = file.stat.bind(file)
    const originalClose = file.close.bind(file)
    file.stat = (async () => {
      const before = await originalStat()
      await fs.truncate(target, MAX_WORKSPACE_DOWNLOAD_BYTES + 1)
      return before
    }) as typeof file.stat
    file.close = async () => { closed = true; await originalClose() }
    return file
  })
  try {
    const service = new WorkspaceService(async () => directory)
    await expect(service.readDownloadFile('fixture', 'growing.bin')).rejects.toMatchObject({
      statusCode: 413, code: 'PAYLOAD_TOO_LARGE',
    })
    expect(closed).toBe(true)
  } finally {
    open.mockRestore()
  }
})

it('honors cancellation before touching the workspace', async () => {
  const controller = new AbortController()
  controller.abort()
  let resolved = false
  const service = new WorkspaceService(async () => { resolved = true; return null })
  await expect(service.readDownloadFile('fixture', 'anything.txt', controller.signal)).rejects.toThrow()
  expect(resolved).toBe(false)
})

it.skipIf(process.platform === 'win32')('rejects an ancestor symlink swap between initial realpath and stat', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-download-swap-'))
  directories.push(directory)
  const work = path.join(directory, 'work')
  const outside = path.join(directory, 'outside')
  await fs.mkdir(path.join(work, 'folder'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(work, 'folder', 'report.txt'), 'workspace report')
  await fs.writeFile(path.join(outside, 'report.txt'), 'outside fake secret fixture')
  const service = new WorkspaceService(async () => work)
  const boundary = service as unknown as { safeStat(target: string): Promise<unknown> }
  const originalStat = boundary.safeStat.bind(service)
  let swapped = false
  boundary.safeStat = async (target) => {
    if (!swapped && target.endsWith('/work/folder/report.txt')) {
      swapped = true
      await fs.rename(path.join(work, 'folder'), path.join(work, 'original-folder'))
      await fs.symlink(outside, path.join(work, 'folder'))
    }
    return originalStat(target)
  }
  await expect(service.readDownloadFile('fixture', 'folder/report.txt')).rejects.toThrow(/outside workspace|changed/)
  expect(swapped).toBe(true)
})

it('permits generated files in Codex and Claude worktrees while still blocking their credential paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-download-worktree-'))
  directories.push(directory)
  for (const agent of ['.codex', '.claude']) {
    const work = path.join(directory, agent, 'worktrees', 'checkout')
    await fs.mkdir(work, { recursive: true })
    await fs.writeFile(path.join(work, 'report.txt'), 'ordinary generated report')
    await fs.writeFile(path.join(work, '.env'), 'fake secret fixture')
    const service = new WorkspaceService(async () => work)
    expect((await service.readDownloadFile('fixture', 'report.txt')).bytes.toString()).toBe('ordinary generated report')
    await expect(service.readDownloadFile('fixture', '.env')).rejects.toMatchObject({ statusCode: 403 })
    const config = new WorkspaceService(async () => path.join(directory, agent))
    await fs.writeFile(path.join(directory, agent, 'config.toml'), 'fake secret fixture')
    await expect(config.readDownloadFile('fixture', 'config.toml')).rejects.toMatchObject({ statusCode: 403 })
  }
})
