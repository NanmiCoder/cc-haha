import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createSandboxedTestEnvironment } from '../../pr/test-environment'
import { searchTransportBunOptions } from './searchTransportOptions'

const preload = join(import.meta.dir, 'searchTransport.ts')

test('search preload survives spaced paths and inherited options in another cwd', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'search transport 空格 #'))
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ fixture: true }) })
  try {
    const copiedPreload = join(sandbox, 'search transport.ts')
    // Keep a broken preload/interceptor from reaching a real provider in this test.
    writeFileSync(copiedPreload, `
      const networkFetch = globalThis.fetch
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.hostname !== '127.0.0.1') throw new Error('fixture blocked real network')
        return networkFetch(input, init)
      }
      ${readFileSync(preload, 'utf8')}
      globalThis.searchTransportFixtureLoaded = true
    `)
    const childDir = join(sandbox, 'child cwd')
    mkdirSync(childDir)
    const main = join(sandbox, 'main.ts')
    writeFileSync(main, `
      if (!globalThis.searchTransportFixtureLoaded) throw new Error('preload did not run')
      const response = await fetch('https://api.deepseek.com/v1/tools/search', { method: 'POST' })
      if (!(await response.json()).fixture) throw new Error('missing interception')
      try { await fetch('https://example.invalid/blocked'); throw new Error('network allowed') }
      catch (error) { if (!error.message.includes('blocked external fetch')) throw error }
      if (!process.argv.includes('--child')) {
        const child = Bun.spawn([process.execPath, import.meta.path, '--child'], {
          cwd: process.env.FIXTURE_CHILD_CWD, env: process.env, stdout: 'inherit', stderr: 'inherit',
        })
        if (await child.exited !== 0) throw new Error('child failed')
      }
      console.log('INTERCEPTED')
    `)
    const proc = Bun.spawn([process.execPath, main], {
      cwd: sandbox,
      env: createSandboxedTestEnvironment(sandbox, {
        BUN_OPTIONS: searchTransportBunOptions(copiedPreload),
        MOCK_SEARCH_ORIGIN: `http://127.0.0.1:${server.port}`,
        FIXTURE_CHILD_CWD: childDir,
      }),
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout.trim().split('\n')).toEqual(['INTERCEPTED', 'INTERCEPTED'])
  } finally {
    server.stop(true)
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('search preload blocks external fetch and requires a loopback fixture', async () => {
  const blocked = Bun.spawn([process.execPath, '--preload', preload, '-e', `
    try { await fetch('https://example.com/private') }
    catch (error) { console.log(error.message); process.exit(0) }
    process.exit(1)
  `], {
    env: { PATH: process.env.PATH, BUN_OPTIONS: '--no-env-file', MOCK_SEARCH_ORIGIN: 'http://127.0.0.1:1' },
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(await blocked.exited).toBe(0)
  expect(await new Response(blocked.stdout).text()).toContain('Mock agent lane blocked external fetch')
  const invalid = Bun.spawn([process.execPath, '--preload', preload, '-e', 'process.exit(0)'], {
    env: { PATH: process.env.PATH, BUN_OPTIONS: '--no-env-file', MOCK_SEARCH_ORIGIN: 'https://example.com' },
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(await invalid.exited).not.toBe(0)
  expect(await new Response(invalid.stderr).text()).toContain('requires a loopback origin')
})
