import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { loadConversationForResume } from './conversationRecovery.js'
import { switchSession } from '../bootstrap/state.js'
import type { SessionId } from '../types/ids.js'
import * as processUtils from './process.js'
import { assertSessionAgentProfile, getAgentProfile, initializeSessionAgentProfile, readSessionAgentProfile, setAgentProfile } from './agentProfile.js'
import { flushSessionStorage, getTranscriptPathForSession, recordTranscript, resetProjectForTesting } from './sessionStorage.js'

let dir: string
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TEST_ENABLE_SESSION_PERSISTENCE: process.env.TEST_ENABLE_SESSION_PERSISTENCE }
const id = '66666666-6666-4666-8666-666666666666'
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'profile-session-'))
  process.env.HOME = dir
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  switchSession(id as SessionId, join(dir, 'config', 'projects', 'fixture'))
  resetProjectForTesting()
  setAgentProfile('standard')
  path = getTranscriptPathForSession(id)
  await mkdir(dirname(path), { recursive: true })
})
afterEach(async () => {
  await flushSessionStorage()
  resetProjectForTesting()
  setAgentProfile('standard')
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(dir, { recursive: true, force: true })
})
const meta = (agentProfile: string) => JSON.stringify({ type: 'session-meta', isMeta: true, agentProfile }) + '\n'

test('old metadata migrates to standard without rewriting unknown fields', async () => {
  const fixture = '{"type":"session-meta","isMeta":true,"workDir":"/fixture","future":{"keep":true}}\n'
  await writeFile(path, fixture)
  await initializeSessionAgentProfile({ print: true, resume: id })
  expect(getAgentProfile()).toBe('standard')
  expect(await readFile(path, 'utf8')).toBe(fixture)
})

test('UUID resume inherits lean before tool assembly and later sparse metadata does not reset it', async () => {
  await writeFile(path, meta('lean') + '{"type":"session-meta","workDir":"/fixture"}\n')
  await initializeSessionAgentProfile({ print: true, resume: id })
  expect(getAgentProfile()).toBe('lean')
  await assertSessionAgentProfile(path)
})

test('explicit profile cannot change either existing profile', async () => {
  const exit = spyOn(processUtils, 'exitWithError').mockImplementation(message => { throw new Error(message) })
  try {
    for (const stored of ['standard', 'lean']) {
      await writeFile(path, meta(stored))
      await expect(initializeSessionAgentProfile({ print: true, resume: id, agentProfile: stored === 'lean' ? 'standard' : 'lean' })).rejects.toThrow('cannot be changed')
    }
  } finally { exit.mockRestore() }
})

test('interactive, continue-style recovery and fork cannot silently use lean history', async () => {
  await writeFile(path, meta('lean'))
  await expect(assertSessionAgentProfile(path)).rejects.toThrow('uses --agent-profile lean')
  const exit = spyOn(processUtils, 'exitWithError').mockImplementation(message => { throw new Error(message) })
  try {
    await expect(initializeSessionAgentProfile({ resume: id })).rejects.toThrow('requires --print')
    await expect(initializeSessionAgentProfile({ print: true, resume: id, forkSession: true })).rejects.toThrow('--fork-session')
  } finally { exit.mockRestore() }
})

test('invalid and conflicting stored profiles fail closed', async () => {
  await writeFile(path, meta('other'))
  await expect(readSessionAgentProfile(path)).rejects.toThrow('Invalid agent profile')
  await writeFile(path, meta('lean') + meta('standard'))
  await expect(readSessionAgentProfile(path)).rejects.toThrow('Conflicting agent profiles')
})

test('real transcript writer persists the selected profile and preserves user history', async () => {
  setAgentProfile('lean')
  await recordTranscript([{ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'saved prompt' } } as never])
  await flushSessionStorage()
  expect(await readSessionAgentProfile(path)).toBe('lean')
  expect(await readFile(path, 'utf8')).toContain('saved prompt')
  setAgentProfile('standard')
  await expect(loadConversationForResume(id, path)).rejects.toThrow('uses --agent-profile lean')
  await initializeSessionAgentProfile({ print: true, resume: id })
  expect(getAgentProfile()).toBe('lean')
})


test('profile lookup projects oversized history and finds metadata after it', async () => {
  const largeMessage = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(6 * 1024 * 1024) } })
  await writeFile(path, largeMessage + '\n' + meta('lean'))
  expect(await readSessionAgentProfile(path)).toBe('lean')
  await initializeSessionAgentProfile({ print: true, resume: id })
  expect(getAgentProfile()).toBe('lean')
})
