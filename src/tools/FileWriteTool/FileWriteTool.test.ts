import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from './FileWriteTool.js'

const directories: string[] = []
const originalSimple = process.env.CLAUDE_CODE_SIMPLE
const originalCheckpoints = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING

beforeEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
})

afterEach(async () => {
  for (const [name, value] of [
    ['CLAUDE_CODE_SIMPLE', originalSimple],
    ['CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING', originalCheckpoints],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function context(deniedPath?: string): ToolUseContext {
  const permissions = getEmptyToolPermissionContext()
  if (deniedPath) permissions.alwaysDenyRules.session = [`Edit(/${deniedPath})`]
  return {
    readFileState: new Map(), abortController: new AbortController(),
    updateFileHistoryState: () => {},
    getAppState: () => ({ toolPermissionContext: permissions }),
  } as unknown as ToolUseContext
}

const variants = [
  (path: string, content: string) => ({ file_path: path, content }),
  (path: string, content: string) => ({ path, file_text: content }),
  (path: string, content: string) => ({ path, file_content: content, description: 'Write fixture' }),
  (path: string, content: string) => ({ file_path: path, file_text: content }),
  (path: string, content: string) => ({ path, content, description: 'Write fixture' }),
  (path: string, content: string) => ({ file_path: path, path, content, file_text: content, file_content: content, description: '' }),
]

test('public Write schema remains canonical and strict', () => {
  const schema = z.toJSONSchema(FileWriteTool.inputSchema)
  expect(Object.keys(schema.properties!)).toEqual(['file_path', 'content'])
  expect(schema.required).toEqual(['file_path', 'content'])
  expect(schema.additionalProperties).toBe(false)
})

for (const [index, variant] of variants.entries()) {
  test(`Write input variant ${index} preserves permission and execution boundaries`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'write-alias-'))
    directories.push(root)
    const path = join(root, 'fixture.txt')
    const raw = variant(path, 'hello\n')
    const snapshot = structuredClone(raw)
    const input = FileWriteTool.inputSchema.parse(raw)
    expect(raw).toEqual(snapshot)
    expect(input).toEqual({ file_path: path, content: 'hello\n' })
    expect(FileWriteTool.getPath(input)).toBe(path)
    expect((await FileWriteTool.checkPermissions(input, context(path))).behavior).toBe('deny')
    expect((await FileWriteTool.validateInput(input, context(path))).result).toBe(false)
    const ctx = context()
    expect(await FileWriteTool.validateInput(input, ctx)).toEqual({ result: true })
    await FileWriteTool.call(input, ctx, undefined as never, { uuid: 'write-alias-test' } as never)
    expect(await readFile(path, 'utf8')).toBe('hello\n')
    expect((await FileWriteTool.validateInput(input, context())).result).toBe(false)
    await FileReadTool.call({ file_path: path }, ctx)
    const update = FileWriteTool.inputSchema.parse(variant(path, 'updated\n'))
    expect(await FileWriteTool.validateInput(update, ctx)).toEqual({ result: true })
    await FileWriteTool.call(update, ctx, undefined as never, { uuid: 'write-alias-update' } as never)
    expect(await readFile(path, 'utf8')).toBe('updated\n')
  })
}

test('conflicting aliases fail with field-specific errors and never change the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'write-conflict-'))
  directories.push(root)
  const path = join(root, 'protected.txt')
  await writeFile(path, 'original')
  for (const raw of [
    { file_path: path, path: `${path}.other`, content: 'replace' },
    { file_path: path, content: 'replace', file_text: 'different' },
    { path, file_text: 'replace', file_content: 'different' },
  ]) {
    const parsed = FileWriteTool.inputSchema.safeParse(raw)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.message).toContain('Conflicting')
    expect(await readFile(path, 'utf8')).toBe('original')
  }
})

test('missing, malformed and unrecognized inputs remain rejected', () => {
  for (const raw of [
    null, [], 'text', {}, { path: '/tmp/file' }, { file_text: 'text' },
    { path: 1, file_text: 'text' }, { path: '/tmp/file', file_text: null },
    { file_path: '/tmp/file', content: 'text', file_text: 1 },
    { file_path: '/tmp/file', content: 'text', path: null },
    { file_path: '/tmp/file', content: 'text', file_content: undefined },
    { file_path: '/tmp/file', content: 'text', description: {} },
    { file_path: '/tmp/file', content: 'text', force: true },
  ]) expect(FileWriteTool.inputSchema.safeParse(raw).success).toBe(false)
  expect(FileWriteTool.inputSchema.parse({ path: '/tmp/file', file_text: '' })).toEqual({ file_path: '/tmp/file', content: '' })
})

test('alias normalization preserves stale-file validation and execution guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'write-stale-'))
  directories.push(root)
  const path = join(root, 'fixture.txt')
  await writeFile(path, 'initial')
  const ctx = context()
  await FileReadTool.call({ file_path: path }, ctx)
  const state = ctx.readFileState.get(path)!
  ctx.readFileState.set(path, { ...state, timestamp: 0 })
  await writeFile(path, 'external change')
  const input = FileWriteTool.inputSchema.parse({ path, file_content: 'replacement' })
  expect(await FileWriteTool.validateInput(input, ctx)).toMatchObject({ result: false, errorCode: 3 })
  await expect(FileWriteTool.call(input, ctx, undefined as never, { uuid: 'stale-write' } as never)).rejects.toThrow('unexpectedly modified')
  expect(await readFile(path, 'utf8')).toBe('external change')
})
