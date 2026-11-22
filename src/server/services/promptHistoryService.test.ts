import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { appendPromptHistory, listPromptHistory } from './promptHistoryService.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalSkipHistory = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
let tempConfigDir: string | null = null

beforeEach(async () => {
  tempConfigDir = await mkdtemp(path.join(tmpdir(), 'cc-haha-prompt-history-'))
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
})

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalSkipHistory === undefined) {
    delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  } else {
    process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = originalSkipHistory
  }
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = null
  }
})

describe('promptHistoryService', () => {
  test('returns empty list when history.jsonl does not exist', async () => {
    const entries = await listPromptHistory({ project: '/repo/app', sessionId: 'sess-1' })
    expect(entries).toEqual([])
  })

  test('orders current session entries before other sessions in the same project (newest-first)', async () => {
    const historyPath = path.join(tempConfigDir!, 'history.jsonl')
    const lines = [
      JSON.stringify({ display: 'other project prompt', pastedContents: {}, timestamp: 1, project: '/repo/other', sessionId: 'sess-other' }),
      JSON.stringify({ display: 'older project prompt', pastedContents: {}, timestamp: 2, project: '/repo/app', sessionId: 'sess-0' }),
      JSON.stringify({ display: 'current session first', pastedContents: {}, timestamp: 3, project: '/repo/app', sessionId: 'sess-1' }),
      JSON.stringify({ display: 'newer other session prompt', pastedContents: {}, timestamp: 4, project: '/repo/app', sessionId: 'sess-2' }),
      JSON.stringify({ display: 'current session latest', pastedContents: {}, timestamp: 5, project: '/repo/app', sessionId: 'sess-1' }),
      'malformed-json-line',
    ]
    await writeFile(historyPath, `${lines.join('\n')}\n`, 'utf8')

    const entries = await listPromptHistory({ project: '/repo/app/', sessionId: 'sess-1' })
    expect(entries.map((e) => e.display)).toEqual([
      'current session latest',
      'current session first',
      'newer other session prompt',
      'older project prompt',
    ])
  })

  test('matches worktree project and projectRoot together', async () => {
    await appendPromptHistory({ display: 'main repo prompt', project: '/repo/app', sessionId: 'sess-main', timestamp: 10 })
    await appendPromptHistory({ display: 'worktree prompt', project: '/repo/app/.worktrees/feat', sessionId: 'sess-wt', timestamp: 20 })

    const entries = await listPromptHistory({
      project: '/repo/app/.worktrees/feat',
      projectRoot: '/repo/app',
      sessionId: 'sess-new',
    })
    expect(entries.map((e) => e.display)).toEqual(['worktree prompt', 'main repo prompt'])
  })

  test('respects sessionOnly filter', async () => {
    await appendPromptHistory({ display: 'other session', project: '/repo/app', sessionId: 'sess-a', timestamp: 10 })
    await appendPromptHistory({ display: 'my session', project: '/repo/app', sessionId: 'sess-b', timestamp: 20 })

    const entries = await listPromptHistory({
      project: '/repo/app',
      sessionId: 'sess-b',
      sessionOnly: true,
    })
    expect(entries.map((e) => e.display)).toEqual(['my session'])
  })

  test('expands TUI pasted text references from inline pastedContents', async () => {
    const historyPath = path.join(tempConfigDir!, 'history.jsonl')
    const line = JSON.stringify({
      display: 'Explain [Pasted text #1 +1 lines]',
      pastedContents: {
        1: { id: 1, type: 'text', content: 'const a = 1\nconst b = 2' },
      },
      timestamp: 100,
      project: '/repo/app',
      sessionId: 'tui-1',
    })
    await writeFile(historyPath, `${line}\n`, 'utf8')

    const entries = await listPromptHistory({ project: '/repo/app' })
    expect(entries).toEqual([
      {
        display: 'Explain const a = 1\nconst b = 2',
        timestamp: 100,
        sessionId: 'tui-1',
      },
    ])
  })

  test('skips writing when CLAUDE_CODE_SKIP_PROMPT_HISTORY is truthy', async () => {
    process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
    await appendPromptHistory({ display: 'should not persist', project: '/repo/app', sessionId: 'sess-1' })

    const entries = await listPromptHistory({ project: '/repo/app' })
    expect(entries).toEqual([])
  })

  test('fails closed when neither project nor sessionId is provided', async () => {
    await appendPromptHistory({ display: 'secret project prompt', project: '/repo/private', sessionId: 'sess-priv' })

    const entries = await listPromptHistory({})
    expect(entries).toEqual([])
  })

  test('matches macOS NFC and NFD project paths equivalently', async () => {
    const nfcPath = '/repo/caf\u00e9'
    const nfdPath = '/repo/cafe\u0301'
    await appendPromptHistory({ display: 'unicode path prompt', project: nfcPath, sessionId: 'sess-u' })

    const entries = await listPromptHistory({ project: nfdPath })
    expect(entries.map((e) => e.display)).toEqual(['unicode path prompt'])
  })
})

describe('/api/sessions/prompt-history route', () => {
  test('POST appends and GET lists prompt history entries', async () => {
    const postUrl = new URL('http://localhost:3456/api/sessions/prompt-history')
    const postReq = new Request(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display: 'Check failing unit test',
        project: '/repo/app',
        sessionId: 'sess-http-1',
      }),
    })
    const postRes = await handleSessionsApi(postReq, postUrl, ['api', 'sessions', 'prompt-history'])
    expect(postRes.status).toBe(200)
    expect(await postRes.json()).toEqual({ ok: true })

    const getUrl = new URL('http://localhost:3456/api/sessions/prompt-history?project=%2Frepo%2Fapp&sessionId=sess-http-1&limit=10')
    const getReq = new Request(getUrl, { method: 'GET' })
    const getRes = await handleSessionsApi(getReq, getUrl, ['api', 'sessions', 'prompt-history'])
    expect(getRes.status).toBe(200)
    const data = await getRes.json() as { entries: Array<{ display: string; sessionId?: string }> }
    expect(data.entries).toHaveLength(1)
    expect(data.entries[0]!.display).toBe('Check failing unit test')
    expect(data.entries[0]!.sessionId).toBe('sess-http-1')
  })

  test('validates POST body and GET limit parameter', async () => {
    const badPostUrl = new URL('http://localhost:3456/api/sessions/prompt-history')
    const badPostRes = await handleSessionsApi(
      new Request(badPostUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display: '   ' }),
      }),
      badPostUrl,
      ['api', 'sessions', 'prompt-history'],
    )
    expect(badPostRes.status).toBe(400)

    const badGetUrl = new URL('http://localhost:3456/api/sessions/prompt-history?limit=abc')
    const badGetRes = await handleSessionsApi(
      new Request(badGetUrl, { method: 'GET' }),
      badGetUrl,
      ['api', 'sessions', 'prompt-history'],
    )
    expect(badGetRes.status).toBe(400)
  })
})
