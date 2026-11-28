import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTeamFileAsync, getTeamDir } from './teamHelpers.js'
import { ensureTeamRuntimeControl, readTeamRuntimeControl, mutateTeamRuntimeControl } from './teamRuntimeControlStore.js'

let home: string
let original: NodeJS.ProcessEnv
const teamName = 'control-fixture'
const identity = { leadSessionId: 'lead', incarnationId: createHash('sha256').update(JSON.stringify([teamName, 'lead', 123])).digest('hex') }
beforeEach(async () => {
  original = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'team-control-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
  await writeTeamFileAsync(teamName, { name: teamName, createdAt: 123, leadSessionId: 'lead', leadAgentId: 'team-lead@control-fixture', members: [] })
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await rm(home, { recursive: true, force: true })
})

test('legacy plan migration backs up original files and adopts an owner conservatively paused', async () => {
  const plan = { schemaVersion: 1, state: 'running', future: { preserve: true } }
  await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
  const control = await ensureTeamRuntimeControl(teamName, identity, 'owner-a')
  expect(control).toMatchObject({ schemaVersion: 1, status: 'paused', revision: 1, epoch: 1, ...identity })
  const names = await readdir(getTeamDir(teamName))
  expect(names).toContain('plan.json.bak-before-runtime-control-v1')
  expect(names).toContain('config.json.bak-before-runtime-control-v1')
  expect(JSON.parse(await readFile(join(getTeamDir(teamName), 'plan.json.bak-before-runtime-control-v1'), 'utf8'))).toEqual(plan)
  expect(await ensureTeamRuntimeControl(teamName, identity, 'owner-a')).toEqual(control)
  expect(JSON.parse(await readFile(join(getTeamDir(teamName), 'plan.json'), 'utf8'))).toEqual(plan)
})

test('only a fresh approved launch initializes running; a new owner pauses the same incarnation', async () => {
  const started = await ensureTeamRuntimeControl(teamName, identity, 'owner-a', { approvedLaunch: true })
  expect(started.status).toBe('running')
  const stopped = await ensureTeamRuntimeControl(teamName, identity, 'owner-b')
  expect(stopped.status).toBe('paused')
  expect(stopped.epoch).toBeGreaterThan(started.epoch)
  expect(stopped.revision).toBeGreaterThan(started.revision)
  expect(await ensureTeamRuntimeControl(teamName, identity, 'owner-b')).toEqual(stopped)
})

test('control CAS and the actual team identity reject stale revisions and same-name ABA', async () => {
  const current = await ensureTeamRuntimeControl(teamName, identity, 'owner-a')
  const changed = await mutateTeamRuntimeControl(teamName, { ...identity, expectedRevision: current.revision }, value => ({ ...value, error: 'visible failure' }))
  await expect(mutateTeamRuntimeControl(teamName, { ...identity, expectedRevision: current.revision }, value => value)).rejects.toThrow('changed')
  await writeTeamFileAsync(teamName, { name: teamName, createdAt: 124, leadSessionId: 'replacement', leadAgentId: 'team-lead@control-fixture', members: [] })
  await expect(mutateTeamRuntimeControl(teamName, { ...identity, expectedRevision: changed.revision }, value => value)).rejects.toThrow('identity')
})

test('updates preserve unknown control and resume fields, while future schemas are left untouched', async () => {
  const initial = await ensureTeamRuntimeControl(teamName, identity, 'owner-a')
  const path = join(getTeamDir(teamName), 'runtime-control.json')
  const extended = { ...initial, future: { preserved: true }, resume: { requestId: 'human', epoch: initial.epoch, createdAt: 10, eligibleSessionIds: [], startedSessionIds: [], futureResume: true } }
  await writeFile(path, JSON.stringify(extended))
  const next = await mutateTeamRuntimeControl(teamName, { ...identity, expectedRevision: initial.revision }, value => ({ ...value, status: 'paused' }))
  expect(next.future).toEqual({ preserved: true })
  expect(next.resume?.futureResume).toBe(true)
  const future = JSON.stringify({ ...extended, schemaVersion: 77 })
  await writeFile(path, future)
  await expect(readTeamRuntimeControl(teamName, identity)).rejects.toThrow('Unsupported')
  await expect(ensureTeamRuntimeControl(teamName, identity, 'owner-next')).rejects.toThrow('Unsupported')
  expect(await readFile(path, 'utf8')).toBe(future)
})
