import { afterEach, describe, expect, test } from 'bun:test'
import {
  type ContinueCandidateTask,
  extractFilePathsFromPrompt,
  extractTouchedFilesFromActivities,
  findContinueCandidate,
  formatContinueHintError,
  isContinueHintEnabled,
  normalizePath,
} from './workerContinueAdvisor.js'

const T0 = 1_700_000_000_000

function makeTask(overrides: Partial<ContinueCandidateTask>): ContinueCandidateTask {
  return {
    agentId: 'agent-x',
    agentType: 'worker',
    description: 'sample task',
    startTime: T0,
    touchedFiles: [],
    isCompleted: true,
    ...overrides,
  }
}

describe('extractFilePathsFromPrompt', () => {
  test('finds path-with-extension tokens', () => {
    const f = extractFilePathsFromPrompt(
      'Fix the null pointer in src/auth/validate.ts:42 and update src/auth/session.ts',
    )
    expect(f).toContain('src/auth/validate.ts')
    expect(f).toContain('src/auth/session.ts')
  })

  test('finds bare filename with known extension', () => {
    const f = extractFilePathsFromPrompt('update README.md and the package.json scripts')
    expect(f).toContain('readme.md')
    expect(f).toContain('package.json')
  })

  test('normalises to lowercase + forward slashes', () => {
    const f = extractFilePathsFromPrompt('look at C:\\Users\\me\\Project\\Foo.TS for clues')
    // The path-like regex requires more than one separator segment — Foo.TS alone
    // gets picked up by the bare-filename rule.
    expect(f).toContain('foo.ts')
  })

  test('does not pick up symbol mentions', () => {
    const f = extractFilePathsFromPrompt('refactor `handleAuth` to early-return on expiry')
    expect(f.size).toBe(0)
  })

  test('does not pick up version numbers', () => {
    const f = extractFilePathsFromPrompt('upgrade to react 18.2.0 and node 20.10')
    // Version numbers don't match either rule (no path separator + extension is
    // not in the known list).
    expect(f.size).toBe(0)
  })

  test('returns empty set on empty input', () => {
    expect(extractFilePathsFromPrompt('').size).toBe(0)
    expect(extractFilePathsFromPrompt('please look at the thing').size).toBe(0)
  })
})

describe('normalizePath', () => {
  test('lowercases and forward-slashes', () => {
    expect(normalizePath('SRC\\Auth\\Validate.TS')).toBe('src/auth/validate.ts')
    expect(normalizePath('src/auth/validate.ts')).toBe('src/auth/validate.ts')
  })
})

describe('extractTouchedFilesFromActivities', () => {
  test('pulls file_path from Read/Edit/Write style inputs', () => {
    const got = extractTouchedFilesFromActivities([
      { input: { file_path: 'src/auth/validate.ts' } },
      { input: { file_path: 'src/auth/session.ts', limit: 100 } },
    ])
    expect(got).toEqual(expect.arrayContaining(['src/auth/validate.ts', 'src/auth/session.ts']))
  })

  test('pulls path from Grep/Glob style inputs', () => {
    const got = extractTouchedFilesFromActivities([
      { input: { pattern: 'TODO', path: 'src/auth' } },
    ])
    expect(got).toContain('src/auth')
  })

  test('deduplicates across activities', () => {
    const got = extractTouchedFilesFromActivities([
      { input: { file_path: 'src/foo.ts' } },
      { input: { file_path: 'src/foo.ts' } },
    ])
    expect(got).toEqual(['src/foo.ts'])
  })

  test('ignores activities with no path-like fields', () => {
    const got = extractTouchedFilesFromActivities([
      { input: { command: 'git status' } },
      { input: {} },
      // @ts-expect-error testing the defensive missing-input path
      {},
    ])
    expect(got).toEqual([])
  })

  test('normalises path separators', () => {
    const got = extractTouchedFilesFromActivities([
      { input: { file_path: 'src\\auth\\validate.ts' } },
    ])
    expect(got).toEqual(['src/auth/validate.ts'])
  })
})

describe('findContinueCandidate', () => {
  test('returns null when prompt has no file references', () => {
    const c = findContinueCandidate({
      prompt: 'fix the bug',
      subagentType: 'worker',
      candidates: [makeTask({ touchedFiles: ['src/x.ts'] })],
      options: { now: T0 + 1000 },
    })
    expect(c).toBeNull()
  })

  test('returns null when no task overlaps', () => {
    const c = findContinueCandidate({
      prompt: 'investigate src/foo/bar.ts',
      subagentType: 'worker',
      candidates: [makeTask({ touchedFiles: ['src/x.ts', 'src/y.ts'] })],
      options: { now: T0 + 1000 },
    })
    expect(c).toBeNull()
  })

  test('returns the candidate when one shared file', () => {
    const c = findContinueCandidate({
      prompt: 'investigate src/auth/validate.ts and add the null check',
      subagentType: 'worker',
      candidates: [
        makeTask({
          agentId: 'a-1',
          touchedFiles: ['src/auth/validate.ts'],
          description: 'auth investigation',
        }),
      ],
      options: { now: T0 + 1000 },
    })
    expect(c).not.toBeNull()
    expect(c?.agentId).toBe('a-1')
    expect(c?.sharedFiles).toEqual(['src/auth/validate.ts'])
  })

  test('breaks ties by most-shared then most-recent', () => {
    const c = findContinueCandidate({
      prompt: 'investigate src/auth/validate.ts and src/auth/session.ts',
      subagentType: 'worker',
      candidates: [
        makeTask({
          agentId: 'older-low-overlap',
          touchedFiles: ['src/auth/validate.ts'],
          startTime: T0,
        }),
        makeTask({
          agentId: 'newer-high-overlap',
          touchedFiles: ['src/auth/validate.ts', 'src/auth/session.ts'],
          startTime: T0 + 500,
        }),
        makeTask({
          agentId: 'oldest-high-overlap',
          touchedFiles: ['src/auth/validate.ts', 'src/auth/session.ts'],
          startTime: T0 - 1000,
        }),
      ],
      options: { now: T0 + 1000 },
    })
    expect(c?.agentId).toBe('newer-high-overlap')
    expect(c?.sharedFiles.length).toBe(2)
  })

  test('respects subagentType — type mismatch never wins', () => {
    const c = findContinueCandidate({
      prompt: 'review my changes in src/auth/validate.ts',
      subagentType: 'code-reviewer',
      candidates: [
        makeTask({
          agentId: 'wrong-type',
          agentType: 'worker',
          touchedFiles: ['src/auth/validate.ts'],
        }),
      ],
      options: { now: T0 + 1000 },
    })
    expect(c).toBeNull()
  })

  test('skips non-completed tasks', () => {
    const c = findContinueCandidate({
      prompt: 'investigate src/auth/validate.ts',
      subagentType: 'worker',
      candidates: [
        makeTask({
          agentId: 'still-running',
          touchedFiles: ['src/auth/validate.ts'],
          isCompleted: false,
        }),
      ],
      options: { now: T0 + 1000 },
    })
    expect(c).toBeNull()
  })

  test('skips tasks older than maxAgeMs', () => {
    const c = findContinueCandidate({
      prompt: 'investigate src/auth/validate.ts',
      subagentType: 'worker',
      candidates: [
        makeTask({
          agentId: 'too-old',
          touchedFiles: ['src/auth/validate.ts'],
          startTime: T0,
        }),
      ],
      options: { now: T0 + 31 * 60 * 1000 }, // 31 min later, default cap is 30
    })
    expect(c).toBeNull()
  })

  test('respects custom minSharedFiles', () => {
    const c = findContinueCandidate({
      prompt: 'fix src/auth/validate.ts',
      subagentType: 'worker',
      candidates: [
        makeTask({
          agentId: 'one-shared',
          touchedFiles: ['src/auth/validate.ts'],
        }),
      ],
      options: { now: T0 + 1000, minSharedFiles: 2 },
    })
    expect(c).toBeNull()
  })

  test('case-insensitive overlap', () => {
    const c = findContinueCandidate({
      prompt: 'fix SRC/Auth/Validate.TS',
      subagentType: 'worker',
      candidates: [
        makeTask({
          agentId: 'a',
          touchedFiles: ['src/auth/validate.ts'],
        }),
      ],
      options: { now: T0 + 1000 },
    })
    expect(c?.agentId).toBe('a')
  })

  test('Windows-style path overlap normalises to forward slashes', () => {
    const c = findContinueCandidate({
      prompt: 'fix C:\\repo\\src\\auth\\validate.ts',
      subagentType: 'worker',
      candidates: [
        makeTask({
          agentId: 'a',
          // Recorded with mixed separators — normalised on both sides.
          touchedFiles: ['C:\\repo\\src\\auth\\validate.ts'],
        }),
      ],
      options: { now: T0 + 1000 },
    })
    expect(c?.agentId).toBe('a')
  })
})

describe('isContinueHintEnabled', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_COORDINATOR_CONTINUE_HINT
  })

  test('off by default', () => {
    delete process.env.CLAUDE_CODE_COORDINATOR_CONTINUE_HINT
    expect(isContinueHintEnabled()).toBe(false)
  })

  test('on only when exactly "1"', () => {
    process.env.CLAUDE_CODE_COORDINATOR_CONTINUE_HINT = '1'
    expect(isContinueHintEnabled()).toBe(true)
    process.env.CLAUDE_CODE_COORDINATOR_CONTINUE_HINT = 'true'
    expect(isContinueHintEnabled()).toBe(false)
    process.env.CLAUDE_CODE_COORDINATOR_CONTINUE_HINT = '0'
    expect(isContinueHintEnabled()).toBe(false)
  })
})

describe('formatContinueHintError', () => {
  test('mentions agent id, file list, both tool names, and the env flag', () => {
    const msg = formatContinueHintError(
      {
        agentId: 'agent-abc',
        agentType: 'worker',
        description: 'auth investigation',
        sharedFiles: ['src/auth/validate.ts'],
        candidateAgeMs: 60_000,
      },
      'Agent',
      'SendMessage',
    )
    expect(msg).toContain('agent-abc')
    expect(msg).toContain('src/auth/validate.ts')
    expect(msg).toContain('Agent')
    expect(msg).toContain('SendMessage')
    expect(msg).toContain('CLAUDE_CODE_COORDINATOR_CONTINUE_HINT')
  })

  test('truncates long file lists', () => {
    const msg = formatContinueHintError(
      {
        agentId: 'a',
        agentType: 'worker',
        description: 'd',
        sharedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
        candidateAgeMs: 0,
      },
      'Agent',
      'SendMessage',
    )
    expect(msg).toContain('a.ts')
    expect(msg).toContain('+2 more')
  })

  test('does not embed key="value" attribute-style fragments', () => {
    const msg = formatContinueHintError(
      {
        agentId: 'a',
        agentType: 'worker',
        description: 'd',
        sharedFiles: ['x.ts'],
        candidateAgeMs: 0,
      },
      'Agent',
      'SendMessage',
    )
    expect(msg).not.toMatch(/[a-z_][a-z0-9_]*\s*=\s*"/i)
  })
})
