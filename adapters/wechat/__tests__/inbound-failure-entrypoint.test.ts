import { expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

for (const { input, unavailable } of [
  { input: 'keep this task', unavailable: true },
  { input: 'keep this task', unavailable: false },
  { input: '/clear', unavailable: true },
  { input: '/clear', unavailable: false },
  { input: '/send deliverable.txt', unavailable: true },
]) {
  it(`keeps ${input} visible when ${unavailable ? 'session restoration fails' : 'the socket refuses submission'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'wechat-inbound-failure-'))
    const config = join(root, 'config')
    mkdirSync(config)
    writeFileSync(join(config, 'adapters.json'), JSON.stringify({
      wechat: { allowedUsers: ['peer'], defaultWorkDir: root, allowedProjectRoots: [root] },
    }))
    const moduleUrl = (relative: string) => pathToFileURL(join(import.meta.dir, relative)).href
    const script = `
      import { mock, spyOn } from 'bun:test'
      import { Database } from 'bun:sqlite'
      import { join } from 'node:path'
      const protocol = await import(${JSON.stringify(moduleUrl('../protocol.ts'))})
      let polls = 0
      mock.module(${JSON.stringify(moduleUrl('../protocol.ts'))}, () => ({ ...protocol,
        getWechatUpdates: async () => ++polls === 1 ? {
          ret: 0, get_updates_buf: 'accepted-cursor',
          msgs: [{ from_user_id: 'peer', message_id: 1, item_list: [{ type: 1, text_item: { text: ${JSON.stringify(input)} } }] }],
        } : new Promise(() => {}),
        sendWechatText: async () => {}, getWechatConfig: async () => ({}), sendWechatTyping: async () => {},
      }))
      const recovery = await import(${JSON.stringify(moduleUrl('../../common/session-recovery.ts'))})
      mock.module(${JSON.stringify(moduleUrl('../../common/session-recovery.ts'))}, () => ({ ...recovery,
        restoreStoredSessionBinding: async () => ${unavailable ? "({ status: 'unavailable' })" : "({ status: 'restored', session: { sessionId: 'fixture', workDir: process.env.HOME } })"},
      }))
      const { WsBridge } = await import(${JSON.stringify(moduleUrl('../../common/ws-bridge.ts'))})
      spyOn(WsBridge.prototype, 'sendUserMessage').mockReturnValue(false)
      globalThis.fetch = async input => {
        if (String(input).endsWith('/api/sessions/power-activity-lease')) return new Response(null, { status: 404 })
        if (String(input).endsWith('/register')) return Response.json({ leaseId: 'fixture' })
        if (String(input).endsWith('/report')) return Response.json({ ok: true })
        throw new Error('Unexpected network request')
      }
      process.argv.push('--wechat')
      await import(${JSON.stringify(moduleUrl('../index.ts'))})
      const db = new Database(join(process.env.CLAUDE_CONFIG_DIR, 'wechat-runtime.sqlite'), { readonly: true })
      const deadline = Date.now() + 3000
      let row
      while (Date.now() < deadline) {
        row = db.query('SELECT state FROM inbound').get()
        if (row && row.state !== 'received' && row.state !== 'dispatching') break
        await Bun.sleep(10)
      }
      console.log('RESULT:' + JSON.stringify(row))
      db.close()
      process.exit(0)
    `
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], {
      env: {
        PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config,
        ADAPTER_SERVER_URL: 'ws://127.0.0.1:1', ADAPTER_ALLOWED_PROJECT_ROOTS: root,
        WECHAT_ACCOUNT_ID: 'fixture-account', WECHAT_BOT_TOKEN: 'fixture-token',
        WECHAT_BASE_URL: 'http://127.0.0.1:1', CC_HAHA_LOCAL_ACCESS_TOKEN: '', NODE_ENV: 'test',
      }, stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' })
      const result = output.split('\n').find(line => line.startsWith('RESULT:'))
      expect(JSON.parse(result!.slice(7))).toMatchObject({ state: 'uncertain' })
    } finally {
      child.kill()
      await child.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)
}
