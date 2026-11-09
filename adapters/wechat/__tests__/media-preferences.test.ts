import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WechatMediaPreferenceStore } from '../media-preferences.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function location() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-preferences-test-'))
  roots.push(root)
  return path.join(root, 'preferences.json')
}

test('persists voice opt-in across restarts and isolates bindings and users', async () => {
  const file = await location()
  const store = new WechatMediaPreferenceStore(file, 'account-a:binding-1')
  expect(store.get('peer')).toEqual({ enabled: false })
  store.set('peer', { enabled: true, voiceId: 'voice-a' })
  expect(new WechatMediaPreferenceStore(file, 'account-a:binding-1').get('peer')).toEqual({ enabled: true, voiceId: 'voice-a' })
  expect(new WechatMediaPreferenceStore(file, 'account-a:binding-2').get('peer')).toEqual({ enabled: false })
  expect(store.get('other')).toEqual({ enabled: false })
})

test('normalizes legacy booleans forward and preserves unknown fields and other scopes', async () => {
  const file = await location()
  await fs.writeFile(file, JSON.stringify({ version: 0, future: 'preserved', bindings: { old: { peer: true }, other: { peer: { enabled: true, extra: 7 } } } }))
  const store = new WechatMediaPreferenceStore(file, 'old')
  expect(store.get('peer')).toEqual({ enabled: true })
  store.set('peer', { enabled: false })
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  expect(saved.version).toBe(1)
  expect(saved.future).toBe('preserved')
  expect(saved.bindings.other.peer.extra).toBe(7)
  expect(saved.bindings.old.peer.enabled).toBe(false)
  expect(JSON.parse(await fs.readFile(`${file}.v0.bak`, 'utf8')).bindings.old.peer).toBe(true)
})

test('does not overwrite malformed or future preference versions', async () => {
  const file = await location()
  for (const content of ['not json', JSON.stringify({ version: 999 })]) {
    await fs.writeFile(file, content)
    const store = new WechatMediaPreferenceStore(file, 'a')
    expect(() => store.set('peer', { enabled: true })).toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe(content)
  }
})
