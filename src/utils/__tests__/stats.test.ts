import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { aggregateClaudeCodeStatsForRange } from '../stats.js'
import { loadStatsCache, STATS_CACHE_VERSION } from '../statsCache.js'

let tmpConfigDir: string
let originalConfigDir: string | undefined

function dateKey(offsetDays: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

function at(date: string, time: string): string {
  return `${date}T${time}.000Z`
}

function userEntry(uuid: string, timestamp: string, isSidechain = false) {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain,
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
  }
}

function assistantEntry(
  uuid: string,
  timestamp: string,
  usage: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
  options: { model?: string; isSidechain?: boolean; parentUuid?: string } = {},
) {
  return {
    type: 'assistant',
    uuid,
    parentUuid: options.parentUuid ?? null,
    isSidechain: options.isSidechain ?? false,
    timestamp,
    message: {
      role: 'assistant',
      model: options.model ?? 'claude-test',
      content: [],
      usage,
    },
  }
}

async function writeJsonl(path: string, entries: unknown[]) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  )
}

function projectFile(sessionId: string): string {
  return join(tmpConfigDir, 'projects', 'test-project', `${sessionId}.jsonl`)
}

function subagentFile(sessionId: string, agentId: string): string {
  return join(
    tmpConfigDir,
    'projects',
    'test-project',
    sessionId,
    'subagents',
    `agent-${agentId}.jsonl`,
  )
}

function totalForDate(
  dailyModelTokens: Array<{
    date: string
    tokensByModel: { [model: string]: number }
  }>,
  date: string,
): number {
  return Object.values(
    dailyModelTokens.find(day => day.date === date)?.tokensByModel ?? {},
  ).reduce((sum, tokens) => sum + tokens, 0)
}

describe('activity stats token accounting', () => {
  beforeEach(async () => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    tmpConfigDir = await mkdtemp(join(tmpdir(), 'cc-haha-stats-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await rm(tmpConfigDir, { recursive: true, force: true })
  })

  it('buckets assistant usage by message date and includes cache tokens', async () => {
    const sessionStart = dateKey(-2)
    const nextDay = dateKey(-1)

    await writeJsonl(projectFile('cross-midnight'), [
      userEntry('user-1', at(sessionStart, '23:55:00')),
      assistantEntry(
        'assistant-1',
        at(sessionStart, '23:58:00'),
        { input_tokens: 1, output_tokens: 2 },
        { parentUuid: 'user-1' },
      ),
      assistantEntry(
        'assistant-2',
        at(nextDay, '00:05:00'),
        {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        },
        { parentUuid: 'assistant-1' },
      ),
    ])

    const stats = await aggregateClaudeCodeStatsForRange('all')

    expect(totalForDate(stats.dailyModelTokens, sessionStart)).toBe(3)
    expect(totalForDate(stats.dailyModelTokens, nextDay)).toBe(100)
    expect(stats.dailyActivity.find(day => day.date === sessionStart)).toMatchObject({
      sessionCount: 1,
    })
    expect(stats.dailyActivity.find(day => day.date === nextDay)).toMatchObject({
      sessionCount: 1,
    })
    expect(stats.modelUsage['claude-test']).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
    })
  })

  it('counts subagent tokens without counting subagent transcripts as sessions', async () => {
    const today = dateKey(0)

    await writeJsonl(projectFile('parent-session'), [
      userEntry('parent-user', at(today, '10:00:00')),
      assistantEntry(
        'parent-assistant',
        at(today, '10:01:00'),
        { input_tokens: 5, output_tokens: 5 },
        { parentUuid: 'parent-user' },
      ),
    ])
    await writeJsonl(subagentFile('parent-session', '001'), [
      userEntry('agent-user', at(today, '10:02:00'), true),
      assistantEntry(
        'agent-assistant',
        at(today, '10:03:00'),
        {
          input_tokens: 7,
          output_tokens: 8,
          cache_read_input_tokens: 9,
        },
        { isSidechain: true, parentUuid: 'agent-user' },
      ),
    ])

    const stats = await aggregateClaudeCodeStatsForRange('all')

    expect(stats.totalSessions).toBe(1)
    expect(stats.dailyActivity.find(day => day.date === today)).toMatchObject({
      sessionCount: 1,
      messageCount: 2,
    })
    expect(totalForDate(stats.dailyModelTokens, today)).toBe(34)
  })

  it('keeps resumed old sessions in range token totals with active daily session counts', async () => {
    const oldDate = dateKey(-50)
    const inRangeDate = dateKey(-1)

    await writeJsonl(projectFile('resumed-old-session'), [
      userEntry('old-user', at(oldDate, '08:00:00')),
      assistantEntry(
        'recent-assistant',
        at(inRangeDate, '09:00:00'),
        { input_tokens: 12, output_tokens: 13 },
        { parentUuid: 'old-user' },
      ),
    ])

    const stats = await aggregateClaudeCodeStatsForRange('30d')

    expect(stats.totalSessions).toBe(0)
    expect(totalForDate(stats.dailyModelTokens, inRangeDate)).toBe(25)
    expect(totalForDate(stats.dailyModelTokens, oldDate)).toBe(0)
    expect(stats.dailyActivity.find(day => day.date === inRangeDate)).toMatchObject({
      sessionCount: 1,
    })
    expect(stats.dailyActivity.find(day => day.date === oldDate)).toBeUndefined()
  })

  it('does not include future transcript timestamps in bounded ranges', async () => {
    const today = dateKey(0)
    const future = dateKey(3)

    await writeJsonl(projectFile('future-session'), [
      userEntry('today-user', at(today, '10:00:00')),
      assistantEntry(
        'future-assistant',
        at(future, '10:00:00'),
        { input_tokens: 100, output_tokens: 100 },
        { parentUuid: 'today-user' },
      ),
    ])

    const stats = await aggregateClaudeCodeStatsForRange('7d')

    expect(totalForDate(stats.dailyModelTokens, future)).toBe(0)
  })

  it('invalidates pre-v5 stats caches because daily activity accounting changed', async () => {
    await mkdir(tmpConfigDir, { recursive: true })
    await writeFile(
      join(tmpConfigDir, 'stats-cache.json'),
      JSON.stringify({
        version: 3,
        lastComputedDate: dateKey(-1),
        dailyActivity: [{ date: dateKey(-1), messageCount: 1, sessionCount: 1, toolCallCount: 0 }],
        dailyModelTokens: [{ date: dateKey(-1), tokensByModel: { stale: 1 } }],
        modelUsage: {},
        totalSessions: 1,
        totalMessages: 1,
        longestSession: null,
        firstSessionDate: null,
        hourCounts: {},
        totalSpeculationTimeSavedMs: 0,
      }),
      'utf-8',
    )

    const cache = await loadStatsCache()

    expect(STATS_CACHE_VERSION).toBe(5)
    expect(cache.dailyModelTokens).toEqual([])
    expect(cache.totalSessions).toBe(0)
  })
})
