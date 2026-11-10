import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { getFileModificationTime } from '../../utils/file.js'
import * as slowOperations from '../../utils/slowOperations.js'
import { NotebookEditTool } from './NotebookEditTool.js'

const directories: string[] = []
const originalCheckpoints = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
beforeEach(() => { process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1' })
afterEach(async () => {
  if (originalCheckpoints === undefined) delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  else process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = originalCheckpoints
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'notebook-edit-'))
  directories.push(directory)
  const notebookPath = join(directory, 'book.ipynb')
  const original = JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } },
    cells: [
      { id: 'first', cell_type: 'code', source: 'print(1)', metadata: {}, execution_count: 1, outputs: [{ output_type: 'stream', text: '1' }] },
      { id: 'unread', cell_type: 'markdown', source: 'Untouched cell', metadata: {} },
    ],
  })
  await writeFile(notebookPath, original)
  const context = {
    readFileState: new Map([[notebookPath, { content: original, timestamp: getFileModificationTime(notebookPath), offset: undefined, limit: undefined }]]),
    updateFileHistoryState: () => {},
  } as unknown as ToolUseContext
  const input = { notebook_path: notebookPath, cell_id: 'first', new_source: 'print(2)', edit_mode: 'replace' as const }
  return { notebookPath, original, context, input }
}

function externalEdit(filePath: string, content: string) {
  fs.writeFileSync(filePath, content)
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(filePath, future, future)
}

describe('NotebookEdit read and write version guards', () => {
  test.each(['replace', 'insert', 'delete'] as const)('rejects a partial notebook view before %s, including direct calls', async editMode => {
    const f = await fixture()
    f.context.readFileState.set(f.notebookPath, { content: 'only first cell', timestamp: getFileModificationTime(f.notebookPath), offset: undefined, limit: undefined, isPartialView: true })
    const input = { ...f.input, cell_id: 'unread', edit_mode: editMode, cell_type: 'markdown' as const }
    const before = f.context.readFileState.get(f.notebookPath)
    expect(await NotebookEditTool.validateInput(input, f.context)).toMatchObject({ result: false, errorCode: 9 })
    const result = await NotebookEditTool.call(input, f.context, undefined, { uuid: 'partial-notebook' } as never)
    expect(result.data.error).toContain('Read it first')
    expect(await readFile(f.notebookPath, 'utf8')).toBe(f.original)
    expect(f.context.readFileState.get(f.notebookPath)).toBe(before)
  })

  test('rejects a direct call without a read snapshot', async () => {
    const f = await fixture()
    f.context.readFileState.delete(f.notebookPath)
    const result = await NotebookEditTool.call(f.input, f.context, undefined, { uuid: 'missing-read' } as never)
    expect(result.data.error).toContain('Read it first')
    expect(await readFile(f.notebookPath, 'utf8')).toBe(f.original)
  })

  test('preserves an external edit made after validation while permission was pending', async () => {
    const f = await fixture()
    expect(await NotebookEditTool.validateInput(f.input, f.context)).toEqual({ result: true })
    const changed = f.original.replace('Untouched cell', 'User edit during confirmation')
    externalEdit(f.notebookPath, changed)
    const result = await NotebookEditTool.call(f.input, f.context, undefined, { uuid: 'confirmation-race' } as never)
    expect(result.data.error).toContain('modified since read')
    expect(await readFile(f.notebookPath, 'utf8')).toBe(changed)
  })

  test('rechecks the file version after preparing the edited notebook and before writing', async () => {
    const f = await fixture()
    const changed = f.original.replace('Untouched cell', 'Concurrent Jupyter edit')
    const stringify = slowOperations.jsonStringify
    const interception = spyOn(slowOperations, 'jsonStringify').mockImplementation((...args) => {
      externalEdit(f.notebookPath, changed)
      return stringify(...args)
    })
    try {
      const result = await NotebookEditTool.call(f.input, f.context, undefined, { uuid: 'write-race' } as never)
      expect(result.data.error).toContain('modified since read')
      expect(await readFile(f.notebookPath, 'utf8')).toBe(changed)
    } finally { interception.mockRestore() }
  })

  test('edits a fully read unchanged notebook and refreshes its read snapshot', async () => {
    const f = await fixture()
    expect(await NotebookEditTool.validateInput(f.input, f.context)).toEqual({ result: true })
    const result = await NotebookEditTool.call(f.input, f.context, undefined, { uuid: 'valid-edit' } as never)
    expect(result.data.error).toBe('')
    const contents = await readFile(f.notebookPath, 'utf8')
    const notebook = JSON.parse(contents)
    expect(notebook.cells[0]).toMatchObject({ source: 'print(2)', outputs: [], execution_count: null })
    expect(notebook.cells[1].source).toBe('Untouched cell')
    expect(f.context.readFileState.get(f.notebookPath)).toMatchObject({ content: contents, timestamp: getFileModificationTime(f.notebookPath) })
  })
})
