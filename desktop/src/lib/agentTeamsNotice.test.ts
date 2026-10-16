import { describe, expect, it } from 'vitest'
import {
  AGENT_TEAMS_NOTICE_STORAGE_KEY,
  dismissAgentTeamsNotice,
  isAgentTeamsNoticeDismissed,
} from './agentTeamsNotice'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

describe('agentTeamsNotice', () => {
  it('is not dismissed by default', () => {
    expect(isAgentTeamsNoticeDismissed(memoryStorage())).toBe(false)
  })

  it('round-trips the dismissal', () => {
    const storage = memoryStorage()
    dismissAgentTeamsNotice(storage)
    expect(isAgentTeamsNoticeDismissed(storage)).toBe(true)
  })

  it('treats a foreign or corrupt value as not dismissed', () => {
    for (const raw of ['', 'not json', 'null', '[]', '{"dismissed":"yes"}', '{"dismissed":false}']) {
      expect(isAgentTeamsNoticeDismissed(memoryStorage({ [AGENT_TEAMS_NOTICE_STORAGE_KEY]: raw }))).toBe(false)
    }
  })

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(isAgentTeamsNoticeDismissed(broken)).toBe(false)
    expect(() => dismissAgentTeamsNotice(broken)).not.toThrow()
  })
})
