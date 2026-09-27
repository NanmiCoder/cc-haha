import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { TeamPlanAgentSnapshot } from '../../shared/teamPlan.js'

const MAX_PRESET_BYTES = 2 * 1024 * 1024
function sourceHash(path: string): string {
  if (!isAbsolute(path)) throw new Error('Agent preset source path must be absolute')
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > MAX_PRESET_BYTES) throw new Error('Agent preset source is unavailable or too large')
  const content = readFileSync(path)
  if (content.length > MAX_PRESET_BYTES) throw new Error('Agent preset source is too large')
  return createHash('sha256').update(content).digest('hex')
}

/** No settings/plugin reload: proposal preparation must not initialize agent memory. */
export function snapshotTeamPlanPresetSource(agent: { source: string; sourceFilePath?: string; sourceContentHash?: string }): NonNullable<TeamPlanAgentSnapshot['sourceIdentity']> {
  if (agent.source === 'built-in') return { kind: 'builtin' }
  // --agents/SDK JSON definitions are values owned by this leader session,
  // not aliases to a global settings file that can be reloaded later.
  if (agent.source === 'flagSettings') return { kind: 'session' }
  if (!agent.sourceFilePath) throw new Error('Agent preset has no verifiable source. Reload the agent and propose the team again.')
  if (!agent.sourceContentHash || sourceHash(agent.sourceFilePath) !== agent.sourceContentHash) throw new Error('Agent preset changed since it was loaded. Reload the preset and propose the team again.')
  return { kind: 'file', path: agent.sourceFilePath, sha256: agent.sourceContentHash }
}

/** Recheck only at approval; execution uses the approved frozen snapshot. */
export function validateTeamPlanPresetSource(snapshot: TeamPlanAgentSnapshot): void {
  const identity = snapshot.sourceIdentity
  if (!identity) throw new Error('Agent preset source is missing. Propose the team again before approval.')
  if (identity.kind === 'builtin' && snapshot.source === 'built-in') return
  if (identity.kind === 'session' && snapshot.source === 'flagSettings') return
  if (identity.kind !== 'file' || snapshot.source === 'built-in' || snapshot.source === 'flagSettings') throw new Error('Agent preset source identity is invalid')
  try {
    if (sourceHash(identity.path) === identity.sha256) return
  } catch {
    throw new Error('Agent preset source is unavailable. Reload the preset and propose the team again.')
  }
  throw new Error('Agent preset changed after planning. Reload the preset and propose the team again.')
}
