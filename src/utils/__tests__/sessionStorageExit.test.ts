import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

// Exercise the registered shutdown callback in another process. It caches
// enabled settings and never observes the parent's intervening 365→0→365.
const scenarios = [
  'deleted-idle',
  'kept-idle',
  'deleted-queued',
  'first-turn-exit',
  'deleted-then-new-turn',
  'deleted-queued-then-new-turn',
  'replaced-queued-then-new-turn',
] as const
for (const scenario of scenarios) {
  test(`runtime exit retention lifecycle: ${scenario}`, async () => {
    const directory = await mkdtemp('/tmp/session-exit-retention-')
    const env = createSandboxedTestEnvironment(directory, { TEST_ENABLE_SESSION_PERSISTENCE: '1' })
    const configDir = env.CLAUDE_CONFIG_DIR!
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }))
    const source = `
      import { switchSession } from './src/bootstrap/state.ts'
      import { getSettings_DEPRECATED } from './src/utils/settings/settings.ts'
      import { runCleanupFunctions } from './src/utils/cleanupRegistry.ts'
      import { cacheSessionTitle, flushSessionStorage, getTranscriptPathForSession, recordTranscript } from './src/utils/sessionStorage.ts'
      const originalSetTimeout = globalThis.setTimeout
      // Hold the normal 100 ms transcript queue until the real exit callback
      // drains it, making the external deletion race deterministic.
      globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 100 ? 60000 : delay, ...args)
      const scenario = ${JSON.stringify(scenario)}
      const id = 'deadbeef-0000-4000-8000-000000000001'
      const old = {type:'user', uuid:'deadbeef-0000-4000-8000-000000000002', timestamp:'2026-09-10T00:00:00.000Z', message:{role:'user',content:'CACHED EXIT PRIVATE PROMPT'}}
      const queued = {type:'user', uuid:'deadbeef-0000-4000-8000-000000000003', timestamp:'2026-09-10T00:00:01.000Z', message:{role:'user',content:'QUEUED BEFORE DELETE'}}
      const fresh = {type:'user', uuid:'deadbeef-0000-4000-8000-000000000004', timestamp:'2026-09-10T00:00:02.000Z', message:{role:'user',content:'FRESH EXPLICIT TURN'}}
      switchSession(id)
      getSettings_DEPRECATED()
      if (scenario.endsWith('idle')) cacheSessionTitle('CACHED EXIT TITLE')
      if (scenario !== 'first-turn-exit') {
        await recordTranscript([old])
        await flushSessionStorage()
      }
      if (scenario.includes('queued')) await recordTranscript([old, queued])
      if (scenario === 'first-turn-exit') await recordTranscript([fresh])
      process.stdout.write(JSON.stringify({ path: getTranscriptPathForSession(id), cachedDays: getSettings_DEPRECATED().cleanupPeriodDays }) + '\\n')
      await new Promise(resolve => process.stdin.once('data', resolve))
      if (scenario.endsWith('new-turn')) await recordTranscript(scenario.includes('queued') ? [old, queued, fresh] : [old, fresh])
      if (getSettings_DEPRECATED().cleanupPeriodDays !== 365) throw new Error('Child observed disabled settings')
      // This is the same cleanup registry invoked by gracefulShutdown.
      await runCleanupFunctions()
      process.exit(0)
    `
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', source], {
      cwd: join(import.meta.dir, '../../..'), env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const errorOutput = new Response(child.stderr).text()
    try {
      const reader = child.stdout.getReader()
      let ready = ''
      while (!ready.includes('\n')) {
        const result = await reader.read()
        if (result.done) throw new Error(`Runtime exited before ready: ${await errorOutput}`)
        ready += new TextDecoder().decode(result.value)
      }
      const { path, cachedDays } = JSON.parse(ready.trim()) as { path: string; cachedDays: number }
      expect(cachedDays).toBe(365)
      const initial = await readFile(path, 'utf8').catch(() => '')
      expect(initial).not.toContain('QUEUED BEFORE DELETE')
      if (scenario === 'first-turn-exit') expect(initial).toBe('')
      else expect(initial).toContain('CACHED EXIT PRIVATE PROMPT')
      if (scenario.endsWith('idle')) expect(initial).toContain('CACHED EXIT TITLE')
      expect(initial).not.toContain('last-prompt')
      if (scenario.startsWith('deleted')) {
        await writeFile(join(configDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 0 }))
        await unlink(path)
        await writeFile(join(configDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }))
      }
      if (scenario.startsWith('replaced')) {
        // Keep the old inode allocated so replacement detection is deterministic.
        await rename(path, path + '.removed')
        await writeFile(path, '')
      }
      child.stdin.write('exit\n')
      child.stdin.end()
      expect(await child.exited).toBe(0)
      expect(await errorOutput).toBe('')
      if (scenario === 'deleted-idle' || scenario === 'deleted-queued') {
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } else if (scenario === 'kept-idle') {
        const final = await readFile(path, 'utf8')
        expect(final).toContain('"lastPrompt":"CACHED EXIT PRIVATE PROMPT"')
        expect(final.match(/CACHED EXIT TITLE/g)).toHaveLength(2)
      } else {
        const final = await readFile(path, 'utf8')
        expect(final).not.toContain('CACHED EXIT PRIVATE PROMPT')
        expect(final).not.toContain('QUEUED BEFORE DELETE')
        const messages = final.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'user')
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ uuid: 'deadbeef-0000-4000-8000-000000000004', parentUuid: null })
      }
    } finally {
      child.kill()
      await child.exited
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
}
