import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAutoMemPath } from '../../memdir/paths.js'
import {
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
  completeConsolidationLock,
  rollbackConsolidationLock,
  recordConsolidation,
} from './consolidationLock.js'

let directory: string
let previousOverride: string | undefined
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'consolidation-lock-'))
  previousOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = directory
  getAutoMemPath.cache.clear?.()
})
afterEach(async () => {
  if (previousOverride === undefined) delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = previousOverride
  getAutoMemPath.cache.clear?.()
  await rm(directory, { recursive: true, force: true })
})

for (const ageHours of [0, 2]) {
  test(`preserves a legacy successful PID stamp after its process exits (${ageHours}h old, #1349)`, async () => {
    const child = Bun.spawn([process.execPath, '--eval', ''], { stdout: 'ignore', stderr: 'ignore' })
    await child.exited
    const lock = join(directory, '.consolidate-lock')
    await writeFile(lock, String(child.pid))
    const previous = (Date.now() - ageHours * 3_600_000) / 1000
    await utimes(lock, previous, previous)
    expect(await readLastConsolidatedAt()).toBeCloseTo(previous * 1000, 0)
  })
}

test('preserves completed blank-body legacy timestamps', async () => {
  const lock = join(directory, '.consolidate-lock')
  await writeFile(lock, '')
  expect(await readLastConsolidatedAt()).toBeGreaterThan(Date.now() - 5000)
})

test('preserves a live holder timestamp', async () => {
  await writeFile(join(directory, '.consolidate-lock'), String(process.pid))
  expect(await readLastConsolidatedAt()).toBeGreaterThan(Date.now() - 5000)
})

test('successful consolidation releases its holder while preserving the timestamp', async () => {
  expect(await tryAcquireConsolidationLock()).toBe(0)
  const acquired = await readLastConsolidatedAt()
  expect(await tryAcquireConsolidationLock()).toBeNull()
  await completeConsolidationLock()
  expect(await readLastConsolidatedAt()).toBeCloseTo(acquired, 0)
  // A completed attempt no longer excludes its own process from acquiring.
  expect(await tryAcquireConsolidationLock()).toBeCloseTo(acquired, 0)
})

async function leaveInterruptedAttempt(priorMtime: number): Promise<void> {
  const lock = join(directory, '.consolidate-lock')
  if (priorMtime > 0) {
    await writeFile(lock, '')
    await utimes(lock, priorMtime / 1000, priorMtime / 1000)
  }
  const moduleUrl = new URL('./consolidationLock.ts', import.meta.url).href
  const child = Bun.spawn([process.execPath, '--eval',
    `const { tryAcquireConsolidationLock } = await import(${JSON.stringify(moduleUrl)}); await tryAcquireConsolidationLock()`,
  ], { env: { ...process.env }, stdout: 'ignore', stderr: 'pipe' })
  expect(await child.exited).toBe(0)
}

for (const ageHours of [0, 2]) {
  test(`recovers a recognizably interrupted new attempt before the time gate (${ageHours}h old)`, async () => {
    const priorMtime = Date.now() - 48 * 3_600_000
    await leaveInterruptedAttempt(priorMtime)
    const attemptTime = (Date.now() - ageHours * 3_600_000) / 1000
    await utimes(join(directory, '.consolidate-lock'), attemptTime, attemptTime)
    expect(await readLastConsolidatedAt()).toBeCloseTo(priorMtime, 0)
    const prior = await tryAcquireConsolidationLock()
    expect(prior).toBeCloseTo(priorMtime, 0)
    await rollbackConsolidationLock(prior!)
    expect(await readLastConsolidatedAt()).toBeCloseTo(priorMtime, 0)
  })
}

test('recovers an interrupted first attempt with no prior timestamp', async () => {
  await leaveInterruptedAttempt(0)
  expect(await readLastConsolidatedAt()).toBe(0)
  const prior = await tryAcquireConsolidationLock()
  expect(prior).toBe(0)
  await rollbackConsolidationLock(prior!)
  expect(await readLastConsolidatedAt()).toBe(0)
})

test('migrates a legacy successful PID stamp only when a new attempt is acquired', async () => {
  const child = Bun.spawn([process.execPath, '--eval', ''], { stdout: 'ignore', stderr: 'ignore' })
  await child.exited
  const lock = join(directory, '.consolidate-lock')
  const legacy = String(child.pid)
  const previous = Date.now() - 48 * 3_600_000
  await writeFile(lock, legacy)
  await utimes(lock, previous / 1000, previous / 1000)
  expect(await readLastConsolidatedAt()).toBeCloseTo(previous, 0)
  expect(await readFile(lock, 'utf8')).toBe(legacy)
  expect(await tryAcquireConsolidationLock()).toBeCloseTo(previous, 0)
  expect(await readFile(lock, 'utf8')).toContain('auto-dream-v1')
  await rollbackConsolidationLock(previous)
  expect(await readLastConsolidatedAt()).toBeCloseTo(previous, 0)
})

test('manual consolidation records a completed timestamp', async () => {
  await recordConsolidation()
  expect(await readLastConsolidatedAt()).toBeGreaterThan(Date.now() - 5000)
  expect(await tryAcquireConsolidationLock()).toBeGreaterThan(Date.now() - 5000)
})
