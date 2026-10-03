import { expect, spyOn, test } from 'bun:test'
import * as fs from 'fs/promises'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  addHiddenPaneId,
  getTeamFilePath,
  listLeadTeamMemberIdentities,
  mutateTeamFileAsync,
  readTeamFile,
  removeHiddenPaneId,
  removeMemberByAgentId,
  removeMemberFromTeam,
  removeTeammateFromTeamFile,
  setMemberActive,
  setMemberMode,
  setMultipleMemberModes,
  type TeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'
import * as lockfile from '../lockfile.js'

async function withTeamFixture(
  run: (teamName: string, initial: TeamFile) => Promise<void>,
) {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-team-writes-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  const teamName = 'concurrent-team'
  const initial: TeamFile = {
    name: teamName,
    createdAt: 1,
    leadAgentId: `team-lead@${teamName}`,
    hiddenPaneIds: ['%1'],
    members: [0, 1].map(index => ({
      agentId: `worker-${index}@${teamName}`,
      name: `worker-${index}`,
      joinedAt: 1,
      tmuxPaneId: `%${index}`,
      cwd: configDir,
      subscriptions: [],
    })),
  }
  try {
    await writeTeamFileAsync(teamName, initial)
    await run(teamName, initial)
  } finally {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await rm(configDir, { recursive: true, force: true })
  }
}

const mutations: Array<{
  name: string
  run: (name: string) => Promise<boolean>
  verify: (team: TeamFile) => void
}> = [
  {
    name: 'setMemberMode',
    run: name => setMemberMode(name, 'worker-0', 'plan'),
    verify: team => expect(team.members[0]?.mode).toBe('plan'),
  },
  {
    name: 'setMultipleMemberModes',
    run: name => setMultipleMemberModes(name, [{ memberName: 'worker-0', mode: 'plan' }]),
    verify: team => expect(team.members[0]?.mode).toBe('plan'),
  },
  {
    name: 'addHiddenPaneId',
    run: name => addHiddenPaneId(name, '%2'),
    verify: team => expect(team.hiddenPaneIds).toEqual(['%1', '%2']),
  },
  {
    name: 'removeHiddenPaneId',
    run: name => removeHiddenPaneId(name, '%1'),
    verify: team => expect(team.hiddenPaneIds).toEqual([]),
  },
  {
    name: 'removeMemberFromTeam',
    run: name => removeMemberFromTeam(name, '%1'),
    verify: team => {
      expect(team.members.some(m => m.name === 'worker-1')).toBe(false)
      expect(team.hiddenPaneIds).toEqual([])
    },
  },
  {
    name: 'removeMemberByAgentId',
    run: name => removeMemberByAgentId(name, `worker-1@${name}`),
    verify: team => expect(team.members.some(m => m.name === 'worker-1')).toBe(false),
  },
  {
    name: 'removeTeammateFromTeamFile',
    run: name => removeTeammateFromTeamFile(name, { name: 'worker-1' }),
    verify: team => expect(team.members.some(m => m.name === 'worker-1')).toBe(false),
  },
]

for (const mutation of mutations) {
  test(`${mutation.name} waits for a spawning writer and preserves both changes`, async () => {
    await withTeamFixture(async (teamName, initial) => {
      const path = getTeamFilePath(teamName)
      const release = await lockfile.lock(path, { lockfilePath: `${path}.lock` })
      let update: Promise<boolean> | undefined
      try {
        // Simulate spawn holding version V while another writer is invoked.
        update = Promise.resolve(mutation.run(teamName))
        const spawned = { ...initial.members[0]!, agentId: 'spawned', name: 'spawned' }
        await fs.writeFile(`${path}.spawn.tmp`, JSON.stringify({
          ...initial, members: [...initial.members, spawned],
        }))
        await fs.rename(`${path}.spawn.tmp`, path)
      } finally {
        await release()
      }
      expect(await update).toBe(true)
      const team = readTeamFile(teamName)!
      expect(team.members.some(m => m.name === 'spawned')).toBe(true)
      mutation.verify(team)
    })
  })
}

test('readers see the complete old config while a replacement is being written', async () => {
  await withTeamFixture(async (teamName, initial) => {
    const originalWrite = fs.writeFile
    let observed: TeamFile | null | undefined
    const write = spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      await originalWrite(path, '{', options)
      observed = readTeamFile(teamName)
      await originalWrite(path, data)
    })
    try {
      await mutateTeamFileAsync(teamName, team => { team.description = 'updated' })
      expect(observed).toEqual(initial)
      expect(readTeamFile(teamName)?.description).toBe('updated')
    } finally {
      write.mockRestore()
    }
  })
})

test('initial config is invisible until the complete document is published', async () => {
  await withTeamFixture(async (teamName, initial) => {
    const newName = `${teamName}-new`
    const originalWrite = fs.writeFile
    let observed: TeamFile | null | undefined
    const write = spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      await originalWrite(path, '{', options)
      observed = readTeamFile(newName)
      await originalWrite(path, data)
    })
    try {
      await writeTeamFileAsync(newName, initial)
      expect(observed).toBeNull()
      expect(readTeamFile(newName)).toEqual(initial)
    } finally {
      write.mockRestore()
    }
  })
})

for (const failure of ['writeFile', 'rename'] as const) {
  test(`${failure} failure preserves config, cleans temporary files and releases the lock`, async () => {
    await withTeamFixture(async (teamName, initial) => {
      const originalWrite = fs.writeFile
      const injectedError = new Error(`injected ${failure} failure`)
      const operation = failure === 'writeFile'
        ? spyOn(fs, 'writeFile').mockImplementation(async (path, _data, options) => {
          await originalWrite(path, '{', options)
          throw injectedError
        })
        : spyOn(fs, 'rename').mockRejectedValue(injectedError)
      try {
        await expect(setMemberMode(teamName, 'worker-0', 'plan')).rejects.toThrow(injectedError.message)
        expect(readTeamFile(teamName)).toEqual(initial)
        expect(await fs.readdir(join(getTeamFilePath(teamName), '..'))).toEqual(['config.json'])
      } finally {
        operation.mockRestore()
      }
      expect(await setMemberMode(teamName, 'worker-0', 'plan')).toBe(true)
      expect(readTeamFile(teamName)?.members[0]?.mode).toBe('plan')
    })
  })
}

test('boolean mutations preserve missing and no-op behavior without writing', async () => {
  await withTeamFixture(async (teamName, initial) => {
    const write = spyOn(fs, 'writeFile')
    try {
      for (const mutation of mutations) expect(await mutation.run('missing-team')).toBe(false)
      expect(await setMemberMode(teamName, 'unknown', 'plan')).toBe(false)
      expect(await removeMemberByAgentId(teamName, 'unknown')).toBe(false)
      expect(await removeMemberFromTeam(teamName, '%unknown')).toBe(false)
      expect(await removeTeammateFromTeamFile(teamName, {})).toBe(false)
      expect(await removeTeammateFromTeamFile(teamName, { name: 'unknown' })).toBe(false)
      expect(await addHiddenPaneId(teamName, '%1')).toBe(true)
      expect(await removeHiddenPaneId(teamName, '%unknown')).toBe(true)
      expect(await setMultipleMemberModes(teamName, [])).toBe(true)
      expect(write).not.toHaveBeenCalled()
      expect(readTeamFile(teamName)).toEqual(initial)
    } finally {
      write.mockRestore()
    }
  })
})

test('mixed concurrent mutations preserve members, modes, panes and unknown fields', async () => {
  await withTeamFixture(async (teamName, initial) => {
    const extended = { ...initial, futureField: { enabled: true } }
    await writeTeamFileAsync(teamName, extended)
    await Promise.all([
      mutateTeamFileAsync(teamName, team => {
        team.members.push({ ...initial.members[0]!, name: 'spawned', agentId: 'spawned' })
      }),
      setMemberMode(teamName, 'worker-0', 'plan'),
      setMemberActive(teamName, 'worker-0', true),
      removeMemberByAgentId(teamName, initial.members[1]!.agentId),
      addHiddenPaneId(teamName, '%2'),
    ])
    const updated = readTeamFile(teamName)!
    expect(updated.members.map(m => m.name)).toEqual(['worker-0', 'spawned'])
    expect(updated.members[0]).toMatchObject({ mode: 'plan', isActive: true })
    expect(updated.hiddenPaneIds).toEqual(['%1', '%2'])
    expect(updated).toHaveProperty('futureField', { enabled: true })
  })
})

test('Windows replacement retries transient sharing failures without removing live config', async () => {
  await withTeamFixture(async (teamName, initial) => {
    const originalRename = fs.rename
    let attempts = 0
    const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      expect(readTeamFile(teamName)).toEqual(initial)
      if (attempts++ === 0) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      await originalRename(from, to)
    })
    try {
      if (process.platform === 'win32') {
        expect(await setMemberMode(teamName, 'worker-0', 'plan')).toBe(true)
        expect(attempts).toBe(2)
        expect(readTeamFile(teamName)?.members[0]?.mode).toBe('plan')
      } else {
        await expect(setMemberMode(teamName, 'worker-0', 'plan')).rejects.toThrow('sharing violation')
        expect(attempts).toBe(1)
      }
    } finally {
      rename.mockRestore()
    }
  })
})

test('persistent sharing failure has bounded retries and preserves the last good config', async () => {
  await withTeamFixture(async (teamName, initial) => {
    const rename = spyOn(fs, 'rename').mockRejectedValue(
      Object.assign(new Error('sharing violation'), { code: 'EPERM' }),
    )
    try {
      await expect(setMemberMode(teamName, 'worker-0', 'plan')).rejects.toThrow('sharing violation')
      expect(rename).toHaveBeenCalledTimes(process.platform === 'win32' ? 6 : 1)
      expect(readTeamFile(teamName)).toEqual(initial)
      expect(await fs.readdir(join(getTeamFilePath(teamName), '..'))).toEqual(['config.json'])
    } finally {
      rename.mockRestore()
    }
  })
})

test('setMemberActive preserves concurrent updates to different members', async () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-member-active-'))
  process.env.CLAUDE_CONFIG_DIR = configDir

  try {
    const teamName = 'concurrent-team'
    const members: TeamFile['members'] = Array.from(
      { length: 3 },
      (_, index) => ({
        agentId: `worker-${index}@${teamName}`,
        name: `worker-${index}`,
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: process.cwd(),
        subscriptions: [],
        backendType: 'in-process',
        isActive: false,
      }),
    )
    await writeTeamFileAsync(teamName, {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: `team-lead@${teamName}`,
      members,
    })

    await Promise.all(
      members.map(member => setMemberActive(teamName, member.name, true)),
    )

    const updated = readTeamFile(teamName)
    expect(updated?.members).toHaveLength(members.length)
    expect(updated?.members.every(member => member.isActive === true)).toBe(
      true,
    )
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a desktop-hosted lead exit keeps its reviewed team; a terminal lead exit still cleans up', async () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalReview = process.env.CC_HAHA_TEAM_REVIEW_REQUIRED
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-team-session-cleanup-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  const { cleanupSessionTeams, registerTeamForSessionCleanup, unregisterTeamForSessionCleanup, getTeamDir } = await import('./teamHelpers.js')
  const { beginTaskListLifecycle, getCanonicalTeamTaskListId } = await import('../tasks.js')
  const teamName = 'desktop-owned'
  try {
    const createdAt = Date.now()
    const lifecycle = await beginTaskListLifecycle(getCanonicalTeamTaskListId(teamName), { teamName, createdAt, leadSessionId: 'lead-session' })
    await writeTeamFileAsync(teamName, { name: teamName, createdAt, leadAgentId: `team-lead@${teamName}`, leadSessionId: 'lead-session', reviewRequired: true, members: [] })
    registerTeamForSessionCleanup(teamName, lifecycle)

    // The desktop replaces the lead process on provider/permission changes,
    // crashes and reopen; the server owns the team's end of life.
    process.env.CC_HAHA_TEAM_REVIEW_REQUIRED = '1'
    await cleanupSessionTeams()
    expect(readTeamFile(teamName)?.name).toBe(teamName)

    delete process.env.CC_HAHA_TEAM_REVIEW_REQUIRED
    await cleanupSessionTeams()
    expect(readTeamFile(teamName)).toBeNull()
    await expect(fs.access(getTeamDir(teamName))).rejects.toThrow()
  } finally {
    unregisterTeamForSessionCleanup(teamName)
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalReview === undefined) delete process.env.CC_HAHA_TEAM_REVIEW_REQUIRED
    else process.env.CC_HAHA_TEAM_REVIEW_REQUIRED = originalReview
    await rm(configDir, { recursive: true, force: true })
  }
})

test("lists every address of a lead's own team members and nothing from other teams", async () => {
  await withTeamFixture(async (teamName, initial) => {
    await writeTeamFileAsync(teamName, {
      ...initial,
      leadSessionId: 'lead-session',
      members: [
        { ...initial.members[0]!, name: 'team-lead', agentId: `team-lead@${teamName}` },
        { ...initial.members[1]!, sessionId: 'worker-session' },
      ],
    })
    await writeTeamFileAsync('other-team', {
      ...initial,
      name: 'other-team',
      leadSessionId: 'another-lead',
    })

    expect(await listLeadTeamMemberIdentities('lead-session')).toEqual([
      'worker-1',
      `worker-1@${teamName}`,
      'worker-session',
    ])
    expect(await listLeadTeamMemberIdentities('nobody')).toEqual([])
  })
})
