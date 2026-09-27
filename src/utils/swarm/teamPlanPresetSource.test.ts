import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotTeamPlanPresetSource, validateTeamPlanPresetSource } from './teamPlanPresetSource.js'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'team-preset-source-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const hash = (content: string) => createHash('sha256').update(content).digest('hex')
test('pins parsed bytes and rejects edits both before planning and before approval', async () => {
  const path = join(root, 'worker.md')
  await writeFile(path, 'Original instructions')
  const definition = { source: 'projectSettings', sourceFilePath: path, sourceContentHash: hash('Original instructions') }
  const snapshot = { source: definition.source, systemPrompt: 'Original instructions', sourceIdentity: snapshotTeamPlanPresetSource(definition) }
  expect(() => validateTeamPlanPresetSource(snapshot)).not.toThrow()
  await writeFile(path, 'Changed instructions')
  expect(() => snapshotTeamPlanPresetSource(definition)).toThrow('changed since it was loaded')
  expect(() => validateTeamPlanPresetSource(snapshot)).toThrow('changed after planning')
  await rm(path)
  expect(() => validateTeamPlanPresetSource(snapshot)).toThrow('unavailable')
})
test('built-ins and session JSON definitions need no settings reload; old unbound snapshots require replanning', () => {
  expect(() => validateTeamPlanPresetSource({ source: 'built-in', systemPrompt: 'builtin', sourceIdentity: snapshotTeamPlanPresetSource({ source: 'built-in' }) })).not.toThrow()
  expect(() => validateTeamPlanPresetSource({ source: 'flagSettings', systemPrompt: 'session', sourceIdentity: snapshotTeamPlanPresetSource({ source: 'flagSettings' }) })).not.toThrow()
  expect(() => validateTeamPlanPresetSource({ source: 'projectSettings', systemPrompt: 'legacy' })).toThrow('source is missing')
  expect(() => snapshotTeamPlanPresetSource({ source: 'userSettings' })).toThrow('verifiable source')
  expect(() => validateTeamPlanPresetSource({ source: 'projectSettings', systemPrompt: 'spoofed', sourceIdentity: { kind: 'builtin' } })).toThrow('invalid')
})
