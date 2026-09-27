import { describe, expect, test } from 'bun:test'
import { startTeamWorkersBarrier, validateTeamPlanRuntime } from './teamPlanRuntime.js'

test('runtime rejects a legacy review with a teammate name that cannot launch', async () => {
  const plan = { workDir: process.cwd(), members: [{ id: 'reader', name: 'README Reader' }] } as never
  await expect(validateTeamPlanRuntime(plan)).rejects.toThrow('Invalid teammate name: README Reader')
})

describe('team worker ready barrier', () => {
  test('never releases a task before all isolated runtimes are ready', async () => {
    const events: string[] = []
    const ids = await startTeamWorkersBarrier(['cheap', 'capable'], async member => {
      events.push(`prepare:${member}`)
      return member
    }, async member => { events.push(`release:${member}`) }, async id => { events.push(`stop:${id}`) })
    expect(ids).toEqual(['cheap', 'capable'])
    expect(events).toEqual(['prepare:cheap', 'prepare:capable', 'release:cheap', 'release:capable'])
  })
  test('failed preparation rolls back ready workers without sending a task', async () => {
    const released: string[] = []
    const stopped: string[] = []
    await expect(startTeamWorkersBarrier(['a', 'b'], async member => {
      if (member === 'b') throw new Error('provider unavailable')
      return member
    }, async member => { released.push(member) }, async id => { stopped.push(id) })).rejects.toThrow('provider unavailable')
    expect(released).toEqual([])
    expect(stopped).toEqual(['a'])
  })
  test('release failure stops workers and never automatically retries', async () => {
    const released: string[] = []
    const stopped: string[] = []
    await expect(startTeamWorkersBarrier(['a', 'b'], async member => member, async member => {
      released.push(member)
      if (member === 'b') throw new Error('lost SDK connection')
    }, async id => { stopped.push(id) })).rejects.toThrow('lost SDK connection')
    expect(released).toEqual(['a', 'b'])
    expect(stopped).toEqual(['a', 'b'])
  })
})
