/**
 * TeamWatcher -- monitors ~/.claude/teams/ for changes and pushes
 * real-time updates to the team's lead desktop session. Legacy team files
 * without a leadSessionId fall back to all connected clients.
 *
 * Uses polling (setInterval) rather than fs.watch for cross-platform reliability.
 * Detects three kinds of events:
 *   - team_created  : a new team directory with config.json appears
 *   - team_update   : an existing team's config.json content changes
 *   - team_deleted  : a previously-seen team directory disappears
 */

import { readTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'node:crypto'
import { sendToSession, getActiveSessionIds } from '../ws/handler.js'
import type { ServerMessage, TeamMemberStatus } from '../ws/events.js'
import {
  teamIncarnationId,
  teamService,
  type TeamService,
} from './teamService.js'

// ─── Helpers ──────────────────────────────────────────────────────────────

function getTeamsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'teams')
}

type WatchedTeamIdentity = {
  teamName: string
  incarnationId: string
  createdAt: number
  leadSessionId?: string
}

// ─── TeamWatcher ──────────────────────────────────────────────────────────

export class TeamWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private checkPromise: Promise<void> | null = null
  private lastPlanRevisions = new Map<string, string>()
  private lastSnapshots = new Map<string, string>() // teamName -> raw config JSON
  private lastWorkbenchFingerprints = new Map<string, string>()
  private lastLeadSessionIds = new Map<string, string>()
  private lastTeamIdentities = new Map<string, WatchedTeamIdentity>()

  constructor(
    private readonly emit: (message: ServerMessage, leadSessionId?: string) => void = (message, leadSessionId) => {
      if (leadSessionId) {
        sendToSession(leadSessionId, message)
        return
      }
      for (const id of getActiveSessionIds()) sendToSession(id, message)
    },
    private readonly archive: Pick<
      TeamService,
      'getWorkbench' | 'markWorkbenchArchiveDeleted'
    > = teamService,
  ) {}

  /** Start polling for team changes. */
  start(intervalMs = 3000): void {
    if (this.intervalId) return // already running
    // Run an initial check immediately, then start the interval
    void this.scheduleCheck()
    this.intervalId = setInterval(() => void this.scheduleCheck(), intervalMs)
  }

  /** Stop polling. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /** Visible for testing -- force a single poll cycle. */
  checkNow(): Promise<void> {
    return this.scheduleCheck()
  }

  /** Clear internal snapshot state (useful in tests). */
  reset(): void {
    this.lastPlanRevisions.clear()
    this.lastSnapshots.clear()
    this.lastWorkbenchFingerprints.clear()
    this.lastLeadSessionIds.clear()
    this.lastTeamIdentities.clear()
  }

  // ── Core polling logic ─────────────────────────────────────────────────

  private scheduleCheck(): Promise<void> {
    if (this.checkPromise) return this.checkPromise
    const current = this.check().finally(() => {
      if (this.checkPromise === current) this.checkPromise = null
    })
    this.checkPromise = current
    return current
  }

  private async check(): Promise<void> {
    const teamsDir = getTeamsDir()

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(teamsDir, { withFileTypes: true })
    } catch {
      // teams directory doesn't exist yet -- nothing to watch
      // If we previously knew about teams, they are now all "deleted"
      for (const [name] of this.lastSnapshots) {
        const identity = this.lastTeamIdentities.get(name)
        await this.archive.markWorkbenchArchiveDeleted(
          identity?.teamName ?? name,
          identity?.leadSessionId ?? this.lastLeadSessionIds.get(name),
          identity?.incarnationId,
        ).catch(() => {})
        this.broadcast(
          { type: 'team_deleted', teamName: name, ...identity },
          identity?.leadSessionId ?? this.lastLeadSessionIds.get(name),
        )
      }
      this.lastPlanRevisions.clear()
    this.lastSnapshots.clear()
      this.lastWorkbenchFingerprints.clear()
      this.lastLeadSessionIds.clear()
      this.lastTeamIdentities.clear()
      return
    }

    const currentTeamNames = new Set<string>()

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const teamName = entry.name
      currentTeamNames.add(teamName)

      const configPath = path.join(teamsDir, teamName, 'config.json')
      let content: string
      try {
        content = fs.readFileSync(configPath, 'utf-8')
      } catch {
        // config.json not readable (missing / permissions) -- skip
        continue
      }

      // plan.json changes independently of config.json while the CLI drafts a team.
      try {
        const plan = await readTeamPlan(teamName)
        const config = JSON.parse(content) as { name: string; leadSessionId?: string; createdAt: number }
        const incarnation = crypto.createHash('sha256').update(JSON.stringify([config.name, config.leadSessionId ?? '', config.createdAt])).digest('hex')
        if (plan && plan.sessionId === config.leadSessionId && plan.incarnationId === incarnation) {
          const fingerprint = `${plan.planId}:${plan.revision}:${plan.state}`
          if (this.lastPlanRevisions.get(teamName) !== fingerprint) {
            this.lastPlanRevisions.set(teamName, fingerprint)
            this.broadcast({ type: 'team_plan_updated', teamName, sessionId: plan.sessionId, planId: plan.planId, incarnationId: plan.incarnationId, revision: plan.revision, state: plan.state }, plan.sessionId)
          }
        }
      } catch { /* A malformed sidecar must not suppress normal team events. */ }

      const lastContent = this.lastSnapshots.get(teamName)
      const currentIdentity = this.readTeamIdentity(teamName, content)
      const previousIdentity = this.lastTeamIdentities.get(teamName)
      const leadSessionId = currentIdentity?.leadSessionId ??
        previousIdentity?.leadSessionId ??
        this.lastLeadSessionIds.get(teamName)
      const workbenchFingerprint = this.buildWorkbenchFingerprint(
        teamsDir,
        teamName,
        content,
      )

      if (lastContent === undefined) {
        // New team detected
        this.lastSnapshots.set(teamName, content)
        this.lastWorkbenchFingerprints.set(teamName, workbenchFingerprint)
        if (leadSessionId) this.lastLeadSessionIds.set(teamName, leadSessionId)
        if (currentIdentity) this.lastTeamIdentities.set(teamName, currentIdentity)
        this.broadcast({ type: 'team_created', teamName, ...currentIdentity }, leadSessionId)
        await this.archive.getWorkbench(teamName).catch(() => {})
      } else if (content !== lastContent) {
        if (
          previousIdentity &&
          currentIdentity &&
          previousIdentity.incarnationId !== currentIdentity.incarnationId
        ) {
          await this.archive.markWorkbenchArchiveDeleted(
            previousIdentity.teamName,
            previousIdentity.leadSessionId,
            previousIdentity.incarnationId,
          ).catch(() => {})
          this.broadcast(
            { type: 'team_deleted', teamName, ...previousIdentity },
            previousIdentity.leadSessionId,
          )
          this.lastSnapshots.set(teamName, content)
          this.lastWorkbenchFingerprints.set(teamName, workbenchFingerprint)
          this.lastTeamIdentities.set(teamName, currentIdentity)
          if (currentIdentity.leadSessionId) {
            this.lastLeadSessionIds.set(teamName, currentIdentity.leadSessionId)
          } else {
            this.lastLeadSessionIds.delete(teamName)
          }
          this.broadcast(
            { type: 'team_created', teamName, ...currentIdentity },
            currentIdentity.leadSessionId,
          )
          await this.archive.getWorkbench(teamName).catch(() => {})
          continue
        }
        // Team config changed -- extract member statuses and broadcast
        this.lastSnapshots.set(teamName, content)
        try {
          const config = JSON.parse(content)
          if (leadSessionId) this.lastLeadSessionIds.set(teamName, leadSessionId)
          if (currentIdentity) this.lastTeamIdentities.set(teamName, currentIdentity)
          const members = this.extractMemberStatuses(config)
          // Merge inbox-discovered members that are missing from config
          const inboxMembers = this.discoverInboxMembers(teamsDir, teamName, config)
          const subagentMembers = this.discoverSubagentMembers(teamsDir, config)
          const allMembers = [...members, ...inboxMembers, ...subagentMembers]
          this.broadcast({
            type: 'team_update',
            teamName,
            members: allMembers,
            ...currentIdentity,
          }, leadSessionId)
        } catch {
          // JSON parse failed (likely truncated write) — try to recover partial members
          const recovered = this.recoverPartialMembers(content)
          if (recovered.length > 0) {
            this.broadcast({
              type: 'team_update',
              teamName,
              members: recovered,
              ...previousIdentity,
            }, leadSessionId)
          }
          // If nothing recoverable, skip broadcast entirely — don't send empty members
        }
      }

      if (
        lastContent !== undefined &&
        this.lastWorkbenchFingerprints.get(teamName) !== workbenchFingerprint
      ) {
        this.lastWorkbenchFingerprints.set(teamName, workbenchFingerprint)
        await this.archive.getWorkbench(teamName).catch(() => {})
        this.broadcast({
          type: 'team_workbench_updated',
          teamName,
          ...currentIdentity,
        }, leadSessionId)
      }
    }

    // Check for deleted teams (were in lastSnapshots but no longer on disk)
    for (const [name] of this.lastSnapshots) {
      if (!currentTeamNames.has(name)) {
        const identity = this.lastTeamIdentities.get(name)
        const leadSessionId = identity?.leadSessionId ?? this.lastLeadSessionIds.get(name)
        await this.archive.markWorkbenchArchiveDeleted(
          identity?.teamName ?? name,
          leadSessionId,
          identity?.incarnationId,
        ).catch(() => {})
        this.lastSnapshots.delete(name)
        this.lastWorkbenchFingerprints.delete(name)
        this.lastLeadSessionIds.delete(name)
        this.lastTeamIdentities.delete(name)
        this.broadcast({ type: 'team_deleted', teamName: name, ...identity }, leadSessionId)
      }
    }
  }

  /**
   * Config writes are only one part of Agent Teams activity. Task ownership and
   * dependencies live under tasks/, while direct messages live under inboxes/.
   * Hash all three read-only surfaces so the desktop can invalidate its joined
   * workbench snapshot without receiving file paths or partial file contents.
   */
  private buildWorkbenchFingerprint(
    teamsDir: string,
    teamName: string,
    configContent: string,
  ): string {
    const hash = crypto.createHash('sha256')
    hash.update(configContent)
    const configDir = path.dirname(teamsDir)
    this.updateHashFromJsonDirectory(
      hash,
      path.join(configDir, 'tasks', teamName),
    )
    this.updateHashFromJsonDirectory(
      hash,
      path.join(teamsDir, teamName, 'inboxes'),
    )
    return hash.digest('hex')
  }

  private updateHashFromJsonDirectory(
    hash: crypto.Hash,
    directory: string,
  ): void {
    let files: string[]
    try {
      files = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
    } catch {
      hash.update('\u0000missing')
      return
    }

    for (const file of files) {
      hash.update('\u0000' + file + '\u0000')
      try {
        hash.update(fs.readFileSync(path.join(directory, file)))
      } catch {
        hash.update('unreadable')
      }
    }
  }

  private readTeamIdentity(
    teamName: string,
    content: string,
  ): WatchedTeamIdentity | undefined {
    try {
      const config = JSON.parse(content) as Record<string, unknown>
      const createdAt = typeof config.createdAt === 'number'
        ? config.createdAt
        : Number(config.createdAt)
      if (!Number.isFinite(createdAt)) return undefined
      const leadSessionId = typeof config.leadSessionId === 'string' && config.leadSessionId
        ? config.leadSessionId
        : undefined
      const canonicalTeamName = typeof config.name === 'string' && config.name
        ? config.name
        : teamName
      const identity = {
        teamName: canonicalTeamName,
        createdAt,
        ...(leadSessionId ? { leadSessionId } : {}),
      }
      return {
        ...identity,
        incarnationId: teamIncarnationId({
          name: canonicalTeamName,
          createdAt,
          leadSessionId,
        }),
      }
    } catch {
      return undefined
    }
  }

  // ── Member status extraction ───────────────────────────────────────────

  /**
   * Parse the TeamFile config and derive a TeamMemberStatus for each member.
   *
   * The raw config has:
   *   members: [{ agentId, name, agentType, isActive, sessionId, ... }]
   *
   * We map `isActive` to the status enum and use `agentType` / `name` as role.
   */
  extractMemberStatuses(config: Record<string, unknown>): TeamMemberStatus[] {
    const members = config.members
    if (!Array.isArray(members)) return []

    return members.map((m: Record<string, unknown>) => {
      const status = this.deriveStatus(m.isActive as boolean | undefined)
      return {
        agentId: (m.agentId as string) || '',
        role: (m.name as string) || (m.agentType as string) || 'member',
        status,
        // Only the runner's own turn markers are cheap enough to read on every
        // poll. Without one, say nothing so the last full team read stands.
        ...(typeof m.isActive === 'boolean'
          ? { activity: (m.isActive ? 'active' : 'idle') as const }
          : {}),
        currentTask: (m.currentTask as string) || undefined,
      }
    })
  }

  private deriveStatus(isActive: boolean | undefined): TeamMemberStatus['status'] {
    if (isActive === false) return 'idle'
    // isActive === true or undefined => running
    return 'running'
  }

  /**
   * Discover members from inboxes/ that aren't in config.json.
   * Fixes the race condition where concurrent writes to config.json lose members.
   */
  private discoverInboxMembers(
    teamsDir: string,
    teamName: string,
    config: Record<string, unknown>,
  ): TeamMemberStatus[] {
    const inboxDir = path.join(teamsDir, teamName, 'inboxes')
    const configMembers = Array.isArray(config.members) ? config.members : []
    const configNames = new Set(
      configMembers.map((m: Record<string, unknown>) => m.name as string),
    )

    try {
      const files = fs.readdirSync(inboxDir)
      const extra: TeamMemberStatus[] = []

      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const name = file.replace(/\.json$/, '')
        if (name === 'team-lead' || configNames.has(name)) continue

        extra.push({
          agentId: `${name}@${teamName}`,
          role: name,
          status: 'running', // assume running — they have an inbox
          // An inbox proves the member exists, never that it is mid-turn.
          activity: 'unknown',
        })
      }

      return extra
    } catch {
      return []
    }
  }

  private discoverSubagentMembers(
    teamsDir: string,
    config: Record<string, unknown>,
  ): TeamMemberStatus[] {
    const leadSessionId =
      typeof config.leadSessionId === 'string' ? config.leadSessionId : null
    const teamName = typeof config.name === 'string' ? config.name : 'team'
    if (!leadSessionId) return []

    const configMembers = Array.isArray(config.members) ? config.members : []
    const configNames = new Set(
      configMembers.map((m: Record<string, unknown>) => m.name as string),
    )
    const projectsDir = path.join(path.dirname(teamsDir), 'projects')

    try {
      const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true })
      const extra = new Map<string, TeamMemberStatus>()

      for (const entry of projectEntries) {
        if (!entry.isDirectory()) continue
        const subagentsDir = path.join(
          projectsDir,
          entry.name,
          leadSessionId,
          'subagents',
        )

        let files: string[]
        try {
          files = fs.readdirSync(subagentsDir)
        } catch {
          continue
        }

        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const filePath = path.join(subagentsDir, file)
          const inferredName = this.extractSubagentMetadataName(filePath) ??
            this.extractSubagentName(filePath)
          if (
            inferredName &&
            inferredName !== 'team-lead' &&
            !configNames.has(inferredName) &&
            !extra.has(inferredName)
          ) {
            extra.set(inferredName, {
              agentId: `${inferredName}@${teamName}`,
              role: inferredName,
              status: 'running',
              activity: 'unknown',
            })
          }
        }
      }

      return [...extra.values()]
    } catch {
      return []
    }
  }

  /**
   * Attempt to recover member data from truncated/corrupted JSON.
   * Extracts agentId values via regex and constructs minimal member statuses.
   */
  private recoverPartialMembers(rawContent: string): TeamMemberStatus[] {
    const members: TeamMemberStatus[] = []
    // Match complete member-like objects: find "agentId":"..." patterns
    const agentIdRegex = /"agentId"\s*:\s*"([^"]+)"/g
    const nameRegex = /"(?:agentType|name)"\s*:\s*"([^"]+)"/g
    const isActiveRegex = /"isActive"\s*:\s*(true|false)/g

    const agentIds: string[] = []
    const names: string[] = []
    const activeStates: (boolean | undefined)[] = []

    let match: RegExpExecArray | null
    while ((match = agentIdRegex.exec(rawContent)) !== null) {
      agentIds.push(match[1]!)
    }
    while ((match = nameRegex.exec(rawContent)) !== null) {
      names.push(match[1]!)
    }
    while ((match = isActiveRegex.exec(rawContent)) !== null) {
      activeStates.push(match[1] === 'true')
    }

    for (let i = 0; i < agentIds.length; i++) {
      members.push({
        agentId: agentIds[i]!,
        role: names[i] || 'member',
        status: this.deriveStatus(activeStates[i]),
      })
    }

    return members
  }

  private extractSubagentMetadataName(filePath: string): string | null {
    try {
      const metadataPath = filePath.replace(/\.jsonl$/, '.meta.json')
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>
      return typeof metadata.agentType === 'string' && metadata.agentType.trim()
        ? metadata.agentType
        : null
    } catch {
      return null
    }
  }

  private extractSubagentName(filePath: string): string | null {
    try {
      const fd = fs.openSync(filePath, 'r')
      const prefix = Buffer.allocUnsafe(8192)
      let length: number
      try { length = fs.readSync(fd, prefix, 0, prefix.length, 0) } finally { fs.closeSync(fd) }
      const head = prefix.toString('utf8', 0, length)
      const lines = head.split('\n').filter((line) => line.trim().length > 0)

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          if (typeof entry.agentName === 'string' && entry.agentName.trim()) {
            return entry.agentName
          }
          if (typeof entry.agentId === 'string' && entry.agentId.includes('@')) {
            return entry.agentId.split('@')[0] ?? null
          }
        } catch {
          // Ignore malformed preview lines.
        }
      }

      return null
    } catch {
      return null
    }
  }

  // ── Broadcasting ───────────────────────────────────────────────────────

  private broadcast(message: ServerMessage, leadSessionId?: string): void {
    this.emit(message, leadSessionId)
  }
}

export const teamWatcher = new TeamWatcher()
