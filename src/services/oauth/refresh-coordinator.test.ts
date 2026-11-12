import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import * as lockfile from '../../utils/lockfile.js'
import { coordinateOAuthRefresh, oauthFileAuthority } from './refresh-coordinator.js'

let directory: string
let lockSpy: ReturnType<typeof spyOn<typeof lockfile, 'lock'>> | undefined
const tokens = { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1 }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'oauth-lock-')) })
afterEach(async () => {
  lockSpy?.mockRestore()
  lockSpy = undefined
  await rm(directory, { recursive: true, force: true })
})

test('different files and different credential generations do not share a refresh result', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const operation = async () => { calls++; await gate }
  const first = coordinateOAuthRefresh('openai', 'secure:first', tokens, operation)
  const second = coordinateOAuthRefresh('openai', 'secure:second', tokens, operation)
  const replacement = coordinateOAuthRefresh('openai', 'secure:first', { ...tokens, refreshToken: 'new-account' }, operation)
  await Bun.sleep(10)
  release()
  await Promise.all([first, second, replacement])
  expect(calls).toBe(3)
})

test('lock acquisition failure is propagated without sending a refresh and later retry works', async () => {
  lockSpy = spyOn(lockfile, 'lock').mockRejectedValueOnce(Object.assign(new Error('Lock timeout'), { code: 'ELOCKED' }))
  const authority = oauthFileAuthority(join(directory, 'tokens.json'))
  let calls = 0
  await expect(coordinateOAuthRefresh('grok', authority, tokens, async () => { calls++ })).rejects.toThrow('Lock timeout')
  expect(calls).toBe(0)
  lockSpy.mockRestore()
  lockSpy = undefined
  await coordinateOAuthRefresh('grok', authority, tokens, async () => { calls++ })
  expect(calls).toBe(1)
})

test('a compromised lock prevents committing a response and releases the owner', async () => {
  let compromise!: () => void
  let released = false
  lockSpy = spyOn(lockfile, 'lock').mockImplementation(async (_file, options) => {
    compromise = () => options!.onCompromised!(new Error('lost') as never)
    return async () => { released = true }
  })
  const authority = oauthFileAuthority(join(directory, 'tokens.json'))
  let committed = false
  await expect(coordinateOAuthRefresh('openai', authority, tokens, async assertOwnership => {
    compromise()
    assertOwnership()
    committed = true
  })).rejects.toThrow('lock was lost')
  expect(committed).toBe(false)
  expect(released).toBe(true)
})
