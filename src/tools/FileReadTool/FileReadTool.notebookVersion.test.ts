import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { NotebookEditTool } from '../NotebookEditTool/NotebookEditTool.js'
import { FileReadTool } from './FileReadTool.js'

test('a notebook changed during Read cannot authorize an edit of unseen content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notebook-read-version-'))
  const notebookPath = join(directory, 'book.ipynb')
  const notebook = (source: string) => JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{ id: 'first', cell_type: 'markdown', source, metadata: {} }],
  })
  writeFileSync(notebookPath, notebook('original'))
  const context = {
    readFileState: new Map(), abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as unknown as ToolUseContext
  const fs = getFsImplementation()
  const originalRead = fs.readFileBytes.bind(fs)
  const read = spyOn(fs, 'readFileBytes').mockImplementation(async (...args) => {
    const bytes = await originalRead(...args)
    if (args[0] === notebookPath) {
      writeFileSync(notebookPath, notebook('external user edit'))
      const future = new Date(Date.now() + 5000)
      utimesSync(notebookPath, future, future)
    }
    return bytes
  })
  try {
    await expect(FileReadTool.call({ file_path: notebookPath }, context)).rejects.toThrow('changed while reading')
    expect(context.readFileState.has(notebookPath)).toBe(false)
    expect(await NotebookEditTool.validateInput({
      notebook_path: notebookPath, cell_id: 'first', new_source: 'replacement', edit_mode: 'replace',
    }, context)).toMatchObject({ result: false })
    read.mockRestore()
    const current = await FileReadTool.call({ file_path: notebookPath }, context)
    expect(current.data).toMatchObject({ type: 'notebook', file: { cells: [{ source: 'external user edit' }] } })
    expect(await NotebookEditTool.validateInput({
      notebook_path: notebookPath, cell_id: 'first', new_source: 'replacement', edit_mode: 'replace',
    }, context)).toMatchObject({ result: true })
  } finally {
    read.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
