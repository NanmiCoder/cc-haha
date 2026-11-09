import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LiveContext } from '../agent-flow/live'

type ToolResult = { content?: unknown; is_error?: boolean }

/** Real CLI cross-turn reads and permission-wait races, without injecting cache state. */
export async function runNotebookReadGuards(
  ctx: LiveContext,
  readResults: () => ToolResult[],
) {
  const directory = mkdtempSync(join(ctx.workRoot, 'notebook-read-guards-'))
  const path = join(directory, 'fixture.ipynb')
  const original = JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{
      id: 'fixture-cell', cell_type: 'code', metadata: {},
      source: ['print("ORIGINAL_CELL")'], execution_count: 1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['ORIGINAL_CELL\n'] }],
    }],
  })
  writeFileSync(path, original)
  const socket = await ctx.openSocket(await ctx.createSession())
  const editInput = { notebook_path: path, cell_id: 'fixture-cell', new_source: 'print("AGENT_EDIT")' }

  async function issue(tool: string, input: Record<string, unknown>) {
    const start = socket.messages.length
    const resultStart = readResults().length
    socket.send({ type: 'user_message', content: `MOCK_TEAM_OWNER ${JSON.stringify({ tool, input })}` })
    const message = await socket.waitFor(frame =>
      ['permission_request', 'message_complete', 'error'].includes(frame.type),
    ctx.stepTimeoutMs, `${tool} reached permission or completion`, start)
    return { start, resultStart, message }
  }

  function assertResult(resultStart: number, text: string, error: boolean) {
    assert.ok(readResults().slice(resultStart).some(result =>
      Boolean(result.is_error) === error && JSON.stringify(result.content).includes(text)),
    `Expected ${error ? 'error' : 'successful'} tool result containing ${text} to reach the model`)
  }

  try {
    ctx.pinRuntime(socket)
    socket.send({ type: 'set_permission_mode', mode: 'default' })

    const unread = await issue('NotebookEdit', editInput)
    assert.equal(unread.message.type, 'message_complete', 'Unread notebooks must fail before permission')
    assertResult(unread.resultStart, 'File has not been read yet', true)
    assert.equal(readFileSync(path, 'utf8'), original)

    const read = await issue('Read', { file_path: path })
    assert.equal(read.message.type, 'message_complete')
    assertResult(read.resultStart, 'ORIGINAL_CELL', false)

    const pending = await issue('NotebookEdit', editInput)
    assert.equal(pending.message.type, 'permission_request', 'A valid read must reach the permission gate')
    const externallyEdited = original.replaceAll('ORIGINAL_CELL', 'EXTERNAL_CELL')
    const previousMtime = statSync(path).mtimeMs
    writeFileSync(path, externallyEdited)
    // Ensure deterministic ordering even on filesystems with coarse timestamps.
    const externalTime = new Date(Math.max(Date.now(), previousMtime + 2000))
    utimesSync(path, externalTime, externalTime)
    socket.send({ type: 'permission_response', requestId: pending.message.requestId, allowed: true })
    await socket.waitFor(frame => frame.type === 'message_complete', ctx.stepTimeoutMs,
      'stale notebook rejection reaches model', pending.start)
    assertResult(pending.resultStart, 'File has been modified since read', true)
    assert.equal(readFileSync(path, 'utf8'), externallyEdited, 'Concurrent user content must survive approval')

    const reread = await issue('Read', { file_path: path })
    assert.equal(reread.message.type, 'message_complete')
    assertResult(reread.resultStart, 'EXTERNAL_CELL', false)
    const recovered = await issue('NotebookEdit', editInput)
    assert.equal(recovered.message.type, 'permission_request')
    socket.send({ type: 'permission_response', requestId: recovered.message.requestId, allowed: true })
    await socket.waitFor(frame => frame.type === 'message_complete', ctx.stepTimeoutMs,
      'fresh notebook edit reaches model', recovered.start)
    assertResult(recovered.resultStart, 'AGENT_EDIT', false)
    const final = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(final.cells[0].source, 'print("AGENT_EDIT")')
    assert.deepEqual(final.cells[0].outputs, [])
    assert.equal(final.cells[0].execution_count, null)

    writeFileSync(join(ctx.artifactDir, 'notebook-read-guards.json'), JSON.stringify({
      unreadEdit: 'rejected before permission',
      externalChangeDuringPermission: 'rejected after approval',
      externalContentPreserved: true,
      freshReadThenEdit: 'succeeded',
      staleOutputsCleared: true,
      // Read currently returns all notebook cells. isPartialView is a defensive
      // unit-test case, not a state this scenario can honestly create via Read.
      partialView: 'covered by unit tests; notebook Read does not produce this flag',
    }, null, 2))
  } finally {
    socket.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
