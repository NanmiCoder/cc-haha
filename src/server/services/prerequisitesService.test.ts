import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPrerequisitesCache,
  probeHostCommand,
  probeHostCommands,
} from './prerequisitesService'

afterEach(() => {
  clearPrerequisitesCache()
})

/**
 * `bun` is one of the few host commands we can reliably depend on
 * being on PATH everywhere cc-haha is built. For the negative case
 * we use a vanishingly-improbable name.
 *
 * These tests deliberately exercise the real shell — mocking child
 * processes inside vitest is fragile and the probe surface is small
 * enough that a real call is faster than the mock plumbing.
 */
const ALMOST_CERTAINLY_PRESENT = 'bun'
const SHOULD_NEVER_EXIST = 'cc-haha-prereq-probe-target-that-does-not-exist'

describe('probeHostCommand', () => {
  it('returns installed=true for a command that resolves in PATH', async () => {
    const result = await probeHostCommand(ALMOST_CERTAINLY_PRESENT)
    expect(result.command).toBe(ALMOST_CERTAINLY_PRESENT)
    expect(result.installed).toBe(true)
    expect(result.resolvedPath).toBeTruthy()
  })

  it('returns installed=false for a command that does not exist', async () => {
    const result = await probeHostCommand(SHOULD_NEVER_EXIST)
    expect(result.command).toBe(SHOULD_NEVER_EXIST)
    expect(result.installed).toBe(false)
    expect(result.resolvedPath).toBeNull()
  })

  it('rejects shell metacharacters defensively (no execution)', async () => {
    // We do NOT pass through `shell: true` for `where` on Windows, but a
    // malicious plugin manifest could still attempt injection. The probe
    // MUST refuse anything outside the [A-Za-z0-9._+\-] charset.
    const dangerous = ['rm; ls', 'a && b', 'a|b', 'a$(b)', '$(echo x)', 'a b']
    for (const cmd of dangerous) {
      const result = await probeHostCommand(cmd)
      expect(result.installed).toBe(false)
      expect(result.resolvedPath).toBeNull()
    }
  })

  it('handles empty / whitespace-only input', async () => {
    expect((await probeHostCommand('')).installed).toBe(false)
    expect((await probeHostCommand('   ')).installed).toBe(false)
  })

  it('caches results within the TTL window so repeated lookups are cheap', async () => {
    const first = await probeHostCommand(ALMOST_CERTAINLY_PRESENT)
    // Second call within TTL must return the SAME object reference if
    // the cache is doing its job.
    const second = await probeHostCommand(ALMOST_CERTAINLY_PRESENT)
    expect(second).toBe(first)
  })

  it('clearPrerequisitesCache forces a fresh probe', async () => {
    const first = await probeHostCommand(ALMOST_CERTAINLY_PRESENT)
    clearPrerequisitesCache()
    const second = await probeHostCommand(ALMOST_CERTAINLY_PRESENT)
    expect(second).not.toBe(first)
    expect(second.installed).toBe(first.installed)
  })
})

describe('probeHostCommands', () => {
  it('dedupes by command name so a batch with duplicates probes each command once', async () => {
    const results = await probeHostCommands([
      ALMOST_CERTAINLY_PRESENT,
      ALMOST_CERTAINLY_PRESENT,
      ALMOST_CERTAINLY_PRESENT,
      SHOULD_NEVER_EXIST,
    ])
    expect(results.size).toBe(2)
    expect(results.get(ALMOST_CERTAINLY_PRESENT)?.installed).toBe(true)
    expect(results.get(SHOULD_NEVER_EXIST)?.installed).toBe(false)
  })

  it('returns an empty map for empty / whitespace-only input', async () => {
    expect((await probeHostCommands([])).size).toBe(0)
    expect((await probeHostCommands(['', '   '])).size).toBe(0)
  })
})
