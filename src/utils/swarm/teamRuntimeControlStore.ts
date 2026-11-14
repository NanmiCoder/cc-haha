import { createHash, randomUUID } from 'node:crypto'
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { teamRuntimeControlRecordSchema, type TeamRuntimeControlIdentity, type TeamRuntimeControlRecord } from '../../shared/teamRuntimeControl.js'
import { getCanonicalTeamTaskListId, withTaskListLifecycleLock } from '../tasks.js'
import { getTeamDir, readTeamFile, type TeamFile } from './teamHelpers.js'
import { TeamPlanError } from './teamPlanStore.js'

const controlPath = (name: string) => join(getTeamDir(name), 'runtime-control.json')

export function teamControlIdentity(team: TeamFile): TeamRuntimeControlIdentity {
  return {
    leadSessionId: team.leadSessionId ?? '',
    incarnationId: createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId ?? '', team.createdAt])).digest('hex'),
  }
}

function requireTeam(name: string, identity: TeamRuntimeControlIdentity): TeamFile {
  const team = readTeamFile(name)
  const actual = team && teamControlIdentity(team)
  if (!team || actual?.leadSessionId !== identity.leadSessionId || actual.incarnationId !== identity.incarnationId) throw new TeamPlanError('Team identity changed; refresh before continuing')
  return team
}

function parseControl(raw: string, name: string, identity: TeamRuntimeControlIdentity): TeamRuntimeControlRecord {
  let parsed: ReturnType<typeof teamRuntimeControlRecordSchema.safeParse>
  try { parsed = teamRuntimeControlRecordSchema.safeParse(JSON.parse(raw)) }
  catch { throw new TeamPlanError('Unsupported or invalid persisted team runtime control') }
  if (!parsed.success) throw new TeamPlanError('Unsupported or invalid persisted team runtime control')
  const control = parsed.data
  if (control.teamName !== name || control.leadSessionId !== identity.leadSessionId || control.incarnationId !== identity.incarnationId) throw new TeamPlanError('Team control identity changed; refresh before continuing')
  return control
}

/** Read-only CLI check: unknown shapes fail closed and are never rewritten. */
export function readTeamRuntimeControlSync(name: string, identity: TeamRuntimeControlIdentity): TeamRuntimeControlRecord | null {
  requireTeam(name, identity)
  try { return parseControl(readFileSync(controlPath(name), 'utf8'), name, identity) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function readTeamRuntimeControl(name: string, identity: TeamRuntimeControlIdentity): Promise<TeamRuntimeControlRecord | null> {
  requireTeam(name, identity)
  try { return parseControl(await readFile(controlPath(name), 'utf8'), name, identity) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeControl(name: string, value: TeamRuntimeControlRecord): Promise<TeamRuntimeControlRecord> {
  const parsed = teamRuntimeControlRecordSchema.parse(value)
  requireTeam(name, parsed)
  const path = controlPath(name)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(parsed, null, 2))
    requireTeam(name, parsed)
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
  return parsed
}

/**
 * A missing sidecar is a legacy fixture, not evidence of a fresh approval.
 * Back up the unmodified source files before adopting it in a paused state.
 * Each new server owner pauses an existing incarnation before supervising it.
 */
export async function ensureTeamRuntimeControl(
  name: string,
  identity: TeamRuntimeControlIdentity,
  ownerId: string,
  options: { approvedLaunch?: boolean; recoverOwner?: boolean } = {},
): Promise<TeamRuntimeControlRecord> {
  return withTaskListLifecycleLock(getCanonicalTeamTaskListId(name), async () => {
    requireTeam(name, identity)
    const current = await readTeamRuntimeControl(name, identity)
    if (current) {
      if (current.ownerId === ownerId && !options.recoverOwner) return current
      return writeControl(name, { ...current, ownerId, status: 'paused', epoch: current.epoch + 1, revision: current.revision + 1, pausedAt: Date.now(), updatedAt: Date.now(), error: undefined, memberErrors: undefined })
    }
    if (!options.approvedLaunch) {
      for (const file of ['config.json', 'plan.json']) {
        const path = join(getTeamDir(name), file)
        // COPYFILE_EXCL preserves the first pre-migration original on replay.
        await copyFile(path, `${path}.bak-before-runtime-control-v1`, 1).catch(error => {
          if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        })
      }
    }
    const now = Date.now()
    return writeControl(name, { schemaVersion: 1, teamName: name, ...identity, ownerId, revision: 1, epoch: options.approvedLaunch ? 0 : 1, status: options.approvedLaunch ? 'running' : 'paused', updatedAt: now, ...(options.approvedLaunch ? {} : { pausedAt: now }) })
  })
}

/** The team/task lifecycle lock also serializes model snapshot and gate writes. */
export async function mutateTeamRuntimeControl(
  name: string,
  identity: TeamRuntimeControlIdentity & { expectedRevision?: number; expectedEpoch?: number },
  update: (current: TeamRuntimeControlRecord) => Promise<TeamRuntimeControlRecord | undefined> | TeamRuntimeControlRecord | undefined,
): Promise<TeamRuntimeControlRecord> {
  return withTaskListLifecycleLock(getCanonicalTeamTaskListId(name), async () => {
    const current = await readTeamRuntimeControl(name, identity)
    if (!current) throw new TeamPlanError('Team runtime control is unavailable; refresh before continuing')
    if ((identity.expectedRevision !== undefined && current.revision !== identity.expectedRevision) || (identity.expectedEpoch !== undefined && current.epoch !== identity.expectedEpoch)) throw new TeamPlanError('Team control changed; refresh before continuing')
    const next = await update(structuredClone(current))
    if (!next) return current
    return writeControl(name, { ...next, revision: current.revision + 1, updatedAt: Date.now() })
  })
}
