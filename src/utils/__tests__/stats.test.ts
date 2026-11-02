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
  options: {
    model?: string
    isSidechain?: boolean
    parentUuid?: string
    content?: unknown[]
  } = {},
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
      content: options.content ?? [],
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

  it('counts the final usage of a reply whose first content-block line carried zero output', async () => {
    const sessionId = 'zero-first-session'
    const day = dateKey(-1)
    const line = (uuid: string, parentUuid: string, usage: Record<string, number>) => ({
      ...assistantEntry(uuid, `${day}T10:00:00.000Z`, usage, { parentUuid }),
      requestId: 'req_zero_first',
      message: {
        id: 'msg_zero_first',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: uuid }],
        usage,
      },
    })
    await writeJsonl(projectFile(sessionId), [
      userEntry('user-1', `${day}T09:59:00.000Z`),
      line('a1', 'user-1', { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 1000 }),
      line('a2', 'a1', { input_tokens: 100, output_tokens: 4, cache_read_input_tokens: 1000 }),
      line('a3', 'a2', { input_tokens: 100, output_tokens: 250, cache_read_input_tokens: 1000 }),
    ])

    const stats = await aggregateClaudeCodeStatsForRange('all')

    expect(stats.modelUsage['claude-test']).toMatchObject({
      inputTokens: 100,
      outputTokens: 250,
      cacheReadInputTokens: 1000,
    })
    expect(totalForDate(stats.dailyModelTokens, day)).toBe(1350)
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

  it('does not count usage copied from a parent session into a fork', async () => {
    const today = dateKey(0)
    const sourceUser = userEntry('source-user', at(today, '10:00:00'))
    const sourceAssistant = assistantEntry(
      'source-assistant',
      at(today, '10:01:00'),
      { input_tokens: 10, output_tokens: 2 },
      { parentUuid: 'source-user' },
    )

    await writeJsonl(projectFile('source-session'), [
      sourceUser,
      sourceAssistant,
    ])
    await writeJsonl(projectFile('fork-session'), [
      {
        ...sourceUser,
        sessionId: 'fork-session',
        forkedFrom: {
          sessionId: 'source-session',
          messageUuid: 'source-user',
        },
      },
      {
        ...sourceAssistant,
        sessionId: 'fork-session',
        forkedFrom: {
          sessionId: 'source-session',
          messageUuid: 'source-assistant',
        },
      },
      {
        ...userEntry('fork-user', at(today, '10:02:00')),
        parentUuid: 'source-assistant',
        sessionId: 'fork-session',
      },
      {
        ...assistantEntry(
          'fork-assistant',
          at(today, '10:03:00'),
          { input_tokens: 5, output_tokens: 1 },
          { parentUuid: 'fork-user' },
        ),
        sessionId: 'fork-session',
      },
    ])

    const stats = await aggregateClaudeCodeStatsForRange('all')

    expect(stats.totalSessions).toBe(2)
    expect(totalForDate(stats.dailyModelTokens, today)).toBe(18)
    expect(stats.modelUsage['claude-test']).toMatchObject({
      inputTokens: 15,
      outputTokens: 3,
    })
  })

  it('tracks tool and skill usage from main and subagent transcripts', async () => {
    const today = dateKey(0)

    await writeJsonl(projectFile('tool-session'), [
      userEntry('tool-user', at(today, '10:00:00')),
      assistantEntry(
        'tool-assistant',
        at(today, '10:01:00'),
        { input_tokens: 1, output_tokens: 1 },
        {
          parentUuid: 'tool-user',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
            { type: 'tool_use', id: 'tool-2', name: 'Skill', input: { skill: 'frontend-design' } },
            { type: 'tool_use', id: 'tool-3', name: 'mcp__figma__get_screenshot', input: {} },
            { type: 'tool_use', id: 'tool-4', name: 'Skill', input: { skill: 42 } },
          ],
        },
      ),
    ])
    await writeJsonl(subagentFile('tool-session', '001'), [
      userEntry('agent-user', at(today, '10:02:00'), true),
      assistantEntry(
        'agent-assistant',
        at(today, '10:03:00'),
        { input_tokens: 2, output_tokens: 2 },
        {
          isSidechain: true,
          parentUuid: 'agent-user',
          content: [
            { type: 'tool_use', id: 'tool-5', name: 'Skill', input: { skill: 'frontend-design' } },
          ],
        },
      ),
    ])

    const stats = await aggregateClaudeCodeStatsForRange('all')

    expect(stats.totalSessions).toBe(1)
    expect(stats.dailyActivity.find(day => day.date === today)).toMatchObject({
      sessionCount: 1,
      toolCallCount: 5,
    })
    expect(stats.toolUsage).toMatchObject({
      Bash: 1,
      Skill: 3,
      mcp__figma__get_screenshot: 1,
    })
    expect(stats.skillUsage).toEqual({
      'frontend-design': 2,
    })
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

  it('uses fixed inclusive 7d and 30d UTC boundaries', async () => {
    const now = new Date('2026-07-15T12:00:00.000Z')
    for (const [sessionId, date, tokens] of [
      ['inside-7d', '2026-07-09', 7],
      ['outside-7d', '2026-07-08', 8],
      ['inside-30d', '2026-06-16', 30],
      ['outside-30d', '2026-06-15', 31],
    ] as const) {
      await writeJsonl(projectFile(sessionId), [
        userEntry(`${sessionId}-user`, at(date, '10:00:00')),
        assistantEntry(
          `${sessionId}-assistant`,
          at(date, '10:01:00'),
          { input_tokens: tokens },
          { parentUuid: `${sessionId}-user` },
        ),
      ])
    }

    const sevenDays = await aggregateClaudeCodeStatsForRange('7d', { now })
    expect(sevenDays.dailyActivity.map(day => day.date)).toEqual(['2026-07-09'])
    expect(totalForDate(sevenDays.dailyModelTokens, '2026-07-09')).toBe(7)

    const thirtyDays = await aggregateClaudeCodeStatsForRange('30d', { now })
    expect(thirtyDays.dailyActivity.map(day => day.date)).toEqual([
      '2026-06-16',
      '2026-07-08',
      '2026-07-09',
    ])
    expect(totalForDate(thirtyDays.dailyModelTokens, '2026-06-16')).toBe(30)
    expect(totalForDate(thirtyDays.dailyModelTokens, '2026-06-15')).toBe(0)
  })

  it('counts calendar days instead of rounding timestamps within one UTC day', async () => {
    const now = new Date('2026-07-15T23:59:30.000Z')
    await writeJsonl(projectFile('early-session'), [
      userEntry('early-user', '2026-07-15T00:01:00.000Z'),
      assistantEntry(
        'early-assistant',
        '2026-07-15T00:02:00.000Z',
        { input_tokens: 1 },
        { parentUuid: 'early-user' },
      ),
    ])
    await writeJsonl(projectFile('late-session'), [
      userEntry('late-user', '2026-07-15T23:58:00.000Z'),
      assistantEntry(
        'late-assistant',
        '2026-07-15T23:59:00.000Z',
        { input_tokens: 1 },
        { parentUuid: 'late-user' },
      ),
    ])

    const stats = await aggregateClaudeCodeStatsForRange('7d', { now })

    expect(stats.totalSessions).toBe(2)
    expect(stats.totalDays).toBe(1)
  })

  it('anchors the current streak to the UTC activity date in positive-offset timezones', async () => {
    const originalTimezone = process.env.TZ
    process.env.TZ = 'Asia/Shanghai'
    try {
      const now = new Date('2026-07-15T01:00:00.000Z')
      await writeJsonl(projectFile('utc-today-session'), [
        userEntry('today-user', '2026-07-15T00:20:00.000Z'),
        assistantEntry(
          'today-assistant',
          '2026-07-15T00:21:00.000Z',
          { input_tokens: 1 },
          { parentUuid: 'today-user' },
        ),
      ])

      const stats = await aggregateClaudeCodeStatsForRange('7d', { now })

      expect(stats.streaks.currentStreak).toBe(1)
      expect(stats.streaks.currentStreakStart).toBe('2026-07-15')
    } finally {
      if (originalTimezone === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = originalTimezone
      }
    }
  })

  it('invalidates pre-v8 stats caches because token aggregates may under-count zero-first replies or include inherited fork usage', async () => {
    await mkdir(tmpConfigDir, { recursive: true })
    await writeFile(
      join(tmpConfigDir, 'stats-cache.json'),
      JSON.stringify({
        version: 7,
        lastComputedDate: dateKey(-1),
        dailyActivity: [{ date: dateKey(-1), messageCount: 1, sessionCount: 1, toolCallCount: 0 }],
        dailyModelTokens: [{ date: dateKey(-1), tokensByModel: { stale: 1 } }],
        modelUsage: {},
        toolUsage: { stale: 1 },
        skillUsage: { stale: 1 },
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

    expect(STATS_CACHE_VERSION).toBe(8)
    expect(cache.dailyModelTokens).toEqual([])
    expect(cache.toolUsage).toEqual({})
    expect(cache.skillUsage).toEqual({})
    expect(cache.totalSessions).toBe(0)
  })
})
