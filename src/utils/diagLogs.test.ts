import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { logForDiagnosticsNoPII } from './diagLogs.js'

let tmpDir: string
let originalPath: string | undefined

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-haha-diag-writer-'))
  originalPath = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = path.join(tmpDir, 'cli-diagnostics.jsonl')
})

afterEach(async () => {
  if (originalPath === undefined) delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  else process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalPath
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('logForDiagnosticsNoPII', () => {
  test('owns a per-process segment and rotates it without replacing a shared append target', async () => {
    const basePath = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE!
    const activePath = `${basePath}.${process.pid}.current.jsonl`
    fs.writeFileSync(activePath, 'x'.repeat(1024 * 1024))

    logForDiagnosticsNoPII('error', 'after_rotation', { code: 'ROTATED' })

    expect(fs.existsSync(basePath)).toBe(false)
    expect(fs.readFileSync(activePath, 'utf-8')).toContain('after_rotation')
    const completedSegments = (await fsp.readdir(tmpDir)).filter((name) =>
      name.startsWith(`cli-diagnostics.jsonl.${process.pid}.`) && !name.includes('.current.'),
    )
    expect(completedSegments).toHaveLength(1)
  })
})
