import { describe, expect, it } from 'vitest'
import type { Tab } from '../../stores/tabStore'
import { deriveMobileSessionStatus } from './mobileSessionStatus'

type ChatSource = Parameters<typeof deriveMobileSessionStatus>[1][string]

function chat(overrides: Partial<NonNullable<ChatSource>> = {}): NonNullable<ChatSource> {
  return {
    chatState: 'idle',
    connectionState: 'connected',
    pendingPermission: null,
    pendingPermissions: undefined,
    backgroundAgentTasks: undefined,
    ...overrides,
  } as NonNullable<ChatSource>
}

const pending = {
  requestId: 'permission-1',
  toolName: 'Bash',
  input: { command: 'bun run build' },
} as never

describe('deriveMobileSessionStatus', () => {
  it('reads sessions nobody here connected to from the server answer', () => {
    const status = deriveMobileSessionStatus(
      [],
      {},
      new Map([['remote-waiting', 'waiting'], ['remote-running', 'running']]),
    )

    expect([...status.attentionIds]).toEqual(['remote-waiting'])
    expect([...status.runningIds]).toEqual(['remote-running'])
  })

  it('trusts a live socket over a poll that has not caught up yet', () => {
    // Answered on the phone a moment ago: the store has cleared the request,
    // the last poll still says waiting. The row must not keep asking.
    const status = deriveMobileSessionStatus(
      [],
      { answered: chat({ chatState: 'idle' }) },
      new Map([['answered', 'waiting']]),
    )

    expect(status.attentionIds.has('answered')).toBe(false)
    expect(status.runningIds.has('answered')).toBe(false)
  })

  it('still uses the poll for a session whose socket has dropped', () => {
    const status = deriveMobileSessionStatus(
      [],
      { dropped: chat({ connectionState: 'reconnecting' }) },
      new Map([['dropped', 'waiting']]),
    )

    expect(status.attentionIds.has('dropped')).toBe(true)
  })

  it('counts a connected session parked on a card as waiting, not working', () => {
    const status = deriveMobileSessionStatus(
      [{ sessionId: 'card', title: 'Card', type: 'session', status: 'running' } as Tab],
      { card: chat({ chatState: 'tool_executing', pendingPermission: pending }) },
      new Map(),
    )

    expect(status.attentionIds.has('card')).toBe(true)
    expect(status.runningIds.has('card')).toBe(false)
  })

  it('marks a tab the desktop reported running as working', () => {
    const status = deriveMobileSessionStatus(
      [{ sessionId: 'tab', title: 'Tab', type: 'session', status: 'running' } as Tab],
      {},
      new Map(),
    )

    expect(status.runningIds.has('tab')).toBe(true)
  })
})
