import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { prepareOfficialAgentSdkPlaceholder } from './officialAgentSdkPlaceholder.js'

let home: string
let workDir: string
let sessionId: string
let canonical: string
let staged: string
const metadata = JSON.stringify({ type: 'session-meta', isMeta: true, workDir: '/fixture', unknownField: { retained: true } }) + '\n'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cc-haha-sdk-placeholder-'))
  workDir = join(home, 'project')
  sessionId = crypto.randomUUID()
  canonical = join(home, 'projects', sanitizePath(workDir), `${sessionId}.jsonl`)
  staged = join(home, 'projects', 'cc-haha-sdk-startup', `${sessionId}.jsonl`)
  await mkdir(workDir)
  await mkdir(join(home, 'projects', sanitizePath(workDir)), { recursive: true })
})
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
const prepare = (filePath?: string) => prepareOfficialAgentSdkPlaceholder({ configDir: home, sessionId, workDir, filePath })

test('fresh sessions without a placeholder need no filesystem rewrite', async () => {
  const restore = await prepare()
  await restore()
  await restore()
  expect(existsSync(canonical)).toBe(false)
  expect(existsSync(staged)).toBe(false)
})

test('stages metadata and restores latest bytes including unknown fields and title changes', async () => {
  await writeFile(canonical, metadata)
  const restore = await prepare(canonical)
  expect(existsSync(canonical)).toBe(false)
  expect(await readFile(staged, 'utf8')).toBe(metadata)
  const title = JSON.stringify({ type: 'custom-title', customTitle: 'Changed during initialization' }) + '\n'
  await appendFile(staged, title)
  await restore()
  expect(await readFile(canonical, 'utf8')).toBe(metadata + title)
  expect(existsSync(staged)).toBe(false)
})

test('concurrent and repeated restore calls append once and preserve native messages', async () => {
  await writeFile(canonical, metadata)
  const restore = await prepare()
  const native = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Native transcript' } })
  await writeFile(canonical, native)
  await Promise.all([restore(), restore(), restore()])
  await restore()
  expect(await readFile(canonical, 'utf8')).toBe(native + '\n' + metadata)
  expect(existsSync(staged)).toBe(false)
})

test('restore failure keeps recoverable metadata and can be retried', async () => {
  await writeFile(canonical, metadata)
  const restore = await prepare()
  await mkdir(canonical)
  await expect(restore()).rejects.toThrow('not a regular file')
  expect(await readFile(staged, 'utf8')).toBe(metadata)
  await rm(canonical, { recursive: true })
  await restore()
  expect(await readFile(canonical, 'utf8')).toBe(metadata)
  expect(existsSync(staged)).toBe(false)
})

test('a staged placeholder left by a crashed host is discoverable and recoverable on retry', async () => {
  await writeFile(canonical, metadata)
  await prepare()
  const recovered = await prepare(staged)
  await recovered()
  expect(await readFile(canonical, 'utf8')).toBe(metadata)
  expect(existsSync(staged)).toBe(false)
})

test('a staged placeholder is recovered when the canonical path is now absent', async () => {
  await writeFile(canonical, metadata)
  await prepare()
  const recovered = await prepare()
  await recovered()
  expect(await readFile(canonical, 'utf8')).toBe(metadata)
})

test('metadata from a prior work directory restores to the actual SDK project path', async () => {
  const previous = join(home, 'projects', 'previous-work-dir', `${sessionId}.jsonl`)
  await mkdir(join(home, 'projects', 'previous-work-dir'))
  await writeFile(previous, metadata)
  const restore = await prepare(previous)
  expect(existsSync(previous)).toBe(false)
  await restore()
  expect(await readFile(canonical, 'utf8')).toBe(metadata)
})

test('conversation, malformed and unrecognized records are never moved or removed', async () => {
  const rejected = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Keep me' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Keep me' } }),
    JSON.stringify({ type: 'session-meta', message: { role: 'user', content: 'Keep me' } }),
    JSON.stringify({ type: 'future-record', unknown: true }),
    '{"type":"session-meta",',
    'null',
  ]
  for (const contents of rejected) {
    await writeFile(canonical, contents)
    await expect(prepare()).rejects.toThrow()
    expect(await readFile(canonical, 'utf8')).toBe(contents)
    expect(existsSync(staged)).toBe(false)
  }
})

test('unrecognized records added while staged are preserved on a failed restore', async () => {
  await writeFile(canonical, metadata)
  const restore = await prepare()
  const additional = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Keep me' } }) + '\n'
  await appendFile(staged, additional)
  await expect(restore()).rejects.toThrow('conversation or unsupported')
  expect(await readFile(staged, 'utf8')).toBe(metadata + additional)
  expect(existsSync(canonical)).toBe(false)
})

test('competing pending metadata is not overwritten', async () => {
  await writeFile(canonical, metadata)
  await mkdir(join(home, 'projects', 'cc-haha-sdk-startup'))
  const other = JSON.stringify({ type: 'custom-title', customTitle: 'Other launch' }) + '\n'
  await writeFile(staged, other)
  await expect(prepare()).rejects.toThrow('two different pending placeholders')
  expect(await readFile(canonical, 'utf8')).toBe(metadata)
  expect(await readFile(staged, 'utf8')).toBe(other)
})


test('a crash between linking and unlinking does not duplicate or lose metadata', async () => {
  await writeFile(canonical, metadata)
  await mkdir(join(home, 'projects', 'cc-haha-sdk-startup'))
  await link(canonical, staged)
  const restore = await prepare()
  expect(existsSync(canonical)).toBe(false)
  await restore()
  expect(await readFile(canonical, 'utf8')).toBe(metadata)
})

test('restoring an already linked target finishes without appending a duplicate', async () => {
  await writeFile(canonical, metadata)
  const restore = await prepare()
  await link(staged, canonical)
  await restore()
  expect(await readFile(canonical, 'utf8')).toBe(metadata)
  expect(existsSync(staged)).toBe(false)
})

test('symlink placeholders and paths outside the session directory are refused', async () => {
  const target = join(home, 'external.jsonl')
  await writeFile(target, metadata)
  await symlink(target, canonical)
  await expect(prepare()).rejects.toThrow('regular placeholder')
  expect(await readFile(target, 'utf8')).toBe(metadata)
  await expect(prepare(target)).rejects.toThrow('outside the session projects directory')
  await expect(prepareOfficialAgentSdkPlaceholder({ configDir: home, sessionId: '../escape', workDir })).rejects.toThrow('Invalid Agent SDK session identifier')
})
