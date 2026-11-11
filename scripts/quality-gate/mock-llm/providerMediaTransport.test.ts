import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../pr/test-environment'

const preload = join(import.meta.dir, 'providerMediaTransport.ts')

test('provider-media preload preserves request bodies and blocks every other external origin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'provider-media-transport-'))
  const requests: Array<{ path: string; authorization: string | null; body: string }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body: await request.text() })
      return Response.json({ intercepted: true })
    },
  })
  try {
    // This independent guard ensures even a broken preload cannot reach a real
    // provider during its own regression test.
    const guardedPreload = join(home, 'guarded.ts')
    writeFileSync(guardedPreload, `
      const networkFetch = globalThis.fetch
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.hostname !== '127.0.0.1') throw new Error('test blocked real network')
        return networkFetch(input, init)
      }
      ${readFileSync(preload, 'utf8')}
    `)
    const main = join(home, 'main.ts')
    writeFileSync(main, `
      const upload = await fetch('https://api.deepseek.com/files', {
        method: 'POST', headers: { authorization: 'Bearer mock-key' }, body: 'upload-fixture',
      })
      if (!(await upload.json()).intercepted) throw new Error('upload not redirected')
      const message = await fetch(new Request('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST', headers: { authorization: 'Bearer mock-key' }, body: 'message-fixture',
      }))
      if (!(await message.json()).intercepted) throw new Error('Request input not redirected')
      for (const url of ['https://example.com/files', 'https://api.deepseek.com.evil.invalid/files', 'https://api.deepseek.com/unknown']) {
        try { await fetch(url); throw new Error('unexpected request allowed') }
        catch (error) { if (!error.message.includes('blocked external fetch')) throw error }
      }
    `)
    const proc = Bun.spawn([process.execPath, '--no-env-file', '--preload', guardedPreload, main], {
      cwd: home, stdout: 'pipe', stderr: 'pipe',
      env: createSandboxedTestEnvironment(home, { MOCK_PROVIDER_MEDIA_ORIGIN: `http://127.0.0.1:${server.port}` }),
    })
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(requests).toEqual([
      { path: '/files', authorization: 'Bearer mock-key', body: 'upload-fixture' },
      { path: '/anthropic/v1/messages', authorization: 'Bearer mock-key', body: 'message-fixture' },
    ])
  } finally {
    await server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
})

test('provider-media preload refuses a non-loopback destination before startup', async () => {
  const proc = Bun.spawn([process.execPath, '--no-env-file', '--preload', preload, '-e', 'process.exit(0)'], {
    env: { PATH: process.env.PATH, MOCK_PROVIDER_MEDIA_ORIGIN: 'https://api.deepseek.com' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(code).not.toBe(0)
  expect(stderr).toContain('requires a loopback origin')
})
