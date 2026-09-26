import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Point getTranscriptPath at a temp file so the tool reads our fixture
// session instead of the live one. The tool only calls getTranscriptPath, so
// we keep the rest of the real sessionStorage module intact.
let sessionFile = ''
const actualSessionStorage = await import('../../utils/sessionStorage.js')
mock.module('../../utils/sessionStorage.js', () => ({
  ...actualSessionStorage,
  getTranscriptPath: () => sessionFile,
}))

const { VccRecallTool } = await import('./VccRecallTool.js')

const rows = [
  {
    type: 'user',
    uuid: 'u0',
    message: { role: 'user', content: "Let's build a redis cache layer" },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will write the cache module.' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Write',
          input: { file_path: 'src/cache.ts', content: 'export const cache = {}' },
        },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Wrote src/cache.ts' }],
    },
  },
  {
    type: 'assistant',
    uuid: 'a3',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done, added the cache.' }] },
  },
]

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-recall-'))
  sessionFile = path.join(tmpDir, 'session.jsonl')
  fs.writeFileSync(
    sessionFile,
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
})

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

// The tool's call() ignores context/canUseTool/parentMessage, so pass stubs.
const call = (input: unknown) =>
  (VccRecallTool.call as (i: unknown) => Promise<{ data: { text: string } }>)(input)

describe('vcc_recall', () => {
  test('no query returns recent entries', async () => {
    const { data } = await call({})
    expect(data.text).toContain('Session history')
    expect(data.text).toContain('#3')
    expect(data.text).toContain('[assistant]')
  })

  test('keyword query returns ranked matches', async () => {
    const { data } = await call({ query: 'cache' })
    expect(data.text).toMatch(/matches/)
    expect(data.text).toContain('#3')
  })

  test('drill-down #N:path returns the file content', async () => {
    const { data } = await call({ query: '#1:cache.ts' })
    expect(data.text).toContain('File: src/cache.ts')
    expect(data.text).toContain('export const cache = {}')
  })

  test('drill-down #N:file auto-selects a single file op', async () => {
    const { data } = await call({ query: '#1:file' })
    expect(data.text).toContain('File: src/cache.ts')
  })

  test('drill-down unknown entry reports not found', async () => {
    const { data } = await call({ query: '#99:cache.ts' })
    expect(data.text).toContain('#99 not found')
  })

  test("mode:touched aggregates files by path with #N", async () => {
    const { data } = await call({ mode: 'touched' })
    expect(data.text).toContain('files touched')
    expect(data.text).toContain('src/cache.ts')
    expect(data.text).toContain('#1 (Write)')
  })

  test('expand returns full untruncated content for #N', async () => {
    const { data } = await call({ expand: [3] })
    expect(data.text).toContain('#3')
    expect(data.text).toContain('Done, added the cache.')
  })

  test('expand with an out-of-range index reports it', async () => {
    const { data } = await call({ expand: [42] })
    expect(data.text).toContain('Cannot expand indices')
    expect(data.text).toContain('42')
  })

  test('missing session file returns a notice', async () => {
    sessionFile = path.join(tmpDir, 'does-not-exist.jsonl')
    const { data } = await call({})
    expect(data.text).toBe('No session file available.')
  })

  test('page out of range for a search reports the valid range', async () => {
    const { data } = await call({ query: 'cache', page: 50 })
    expect(data.text).toContain('outside the available range')
  })
})
