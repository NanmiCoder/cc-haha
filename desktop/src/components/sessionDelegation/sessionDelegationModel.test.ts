import { describe, expect, it } from 'vitest'
import type { SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import {
  buildDelegatedSessionRows,
  delegationChangeSummaries,
  delegationDecisionBatches,
} from './sessionDelegationModel'

const deepseek = { providerId: 'deepseek', modelId: 'deepseek-flash[1m]' }
const minimax = { providerId: 'minimax', modelId: 'MiniMax-M3.1-Flash[1m]' }

function launched(): SessionDelegationSnapshot {
  return {
    batches: [{ id: 'batch', requestId: 'request', callerSessionId: 'parent', revision: 4, state: 'launched', sessions: [
      { id: 'sec', title: 'Security review', prompt: 'Review security', runtime: deepseek, sessionId: 'child-sec', launched: true },
      { id: 'ux-a', title: 'UX review A', prompt: 'Review flows', runtime: deepseek, sessionId: 'child-ux-a', launched: true },
      { id: 'ux-b', title: 'UX review B', prompt: 'Review a11y', runtime: minimax, sessionId: 'child-ux-b', launched: true },
    ] }],
    models: [
      { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-flash[1m]', modelName: 'deepseek-flash[1m]', supportedEfforts: [], isDefault: true },
      { providerId: 'minimax', providerName: 'MiniMax', modelId: 'MiniMax-M3.1-Flash[1m]', modelName: 'MiniMax-M3.1-Flash[1m]', supportedEfforts: [], isDefault: false },
    ],
    sessions: [
      { sessionId: 'child-sec', runtime: deepseek, state: 'running', paused: false },
      { sessionId: 'child-ux-a', runtime: deepseek, state: 'queued', paused: false },
      { sessionId: 'child-ux-b', runtime: minimax, state: 'running', paused: false },
    ],
    changes: [],
  }
}

function withPendingSwitch(state: 'pending' | 'applying' | 'applied', mode: 'after_turn' | 'immediate' = 'after_turn'): SessionDelegationSnapshot {
  const snapshot = launched()
  snapshot.changes = [{ id: 'change', callerSessionId: 'parent', requestId: 'r', revision: 2, mode, resume: true, state, selections: [
    { sessionId: 'child-sec', runtime: minimax },
    { sessionId: 'child-ux-a', runtime: minimax },
    { sessionId: 'child-ux-b', runtime: minimax },
  ] }]
  return snapshot
}

describe('buildDelegatedSessionRows', () => {
  it('shows each session on the model it actually runs when nothing is pending', () => {
    expect(buildDelegatedSessionRows(launched()).map(row => [row.title, row.status, row.modelLabel, row.pendingSwitch])).toEqual([
      ['Security review', 'running', 'deepseek-flash[1m] · DeepSeek', undefined],
      ['UX review A', 'queued', 'deepseek-flash[1m] · DeepSeek', undefined],
      ['UX review B', 'running', 'MiniMax-M3.1-Flash[1m] · MiniMax', undefined],
    ])
  })

  it('shows the target of an accepted switch at once, and what still runs until the turn ends', () => {
    // The switch waits for every selected session to finish its turn. Until
    // then the rows used to fall back to the old model, so the change looked
    // lost even though every session switched once the turn ended.
    const rows = buildDelegatedSessionRows(withPendingSwitch('pending'))
    expect(rows.map(row => row.modelLabel)).toEqual([
      'MiniMax-M3.1-Flash[1m] · MiniMax',
      'MiniMax-M3.1-Flash[1m] · MiniMax',
      'MiniMax-M3.1-Flash[1m] · MiniMax',
    ])
    expect(rows.map(row => row.pendingSwitch)).toEqual([
      { phase: 'afterTurn', currentModelLabel: 'deepseek-flash[1m]' },
      { phase: 'waiting', currentModelLabel: 'deepseek-flash[1m]' },
      { phase: 'afterTurn' },
    ])
  })

  it('reports an applying or immediate switch as in progress and drops the note once applied', () => {
    expect(buildDelegatedSessionRows(withPendingSwitch('applying'))[0]!.pendingSwitch?.phase).toBe('applying')
    expect(buildDelegatedSessionRows(withPendingSwitch('pending', 'immediate'))[0]!.pendingSwitch?.phase).toBe('applying')
    const applied = withPendingSwitch('applied')
    applied.sessions = applied.sessions!.map(item => ({ ...item, runtime: minimax }))
    expect(buildDelegatedSessionRows(applied).map(row => [row.modelLabel, row.pendingSwitch])).toEqual([
      ['MiniMax-M3.1-Flash[1m] · MiniMax', undefined],
      ['MiniMax-M3.1-Flash[1m] · MiniMax', undefined],
      ['MiniMax-M3.1-Flash[1m] · MiniMax', undefined],
    ])
  })

  it('distinguishes sessions waiting for review, paused, and kept from a cancelled batch', () => {
    const snapshot = launched()
    snapshot.sessions![0] = { ...snapshot.sessions![0]!, paused: true }
    snapshot.batches.push({ id: 'later', requestId: 'r2', callerSessionId: 'parent', revision: 1, state: 'review', sessions: [
      { id: 'perf', title: 'Performance review', prompt: 'Review perf', runtime: deepseek },
    ] })
    snapshot.batches.push({ id: 'dropped', requestId: 'r3', callerSessionId: 'parent', revision: 1, state: 'cancelled', sessions: [
      { id: 'kept', title: 'Started before cancel', prompt: 'x', runtime: deepseek, sessionId: 'child-kept', launched: true },
      { id: 'gone', title: 'Never started', prompt: 'y', runtime: deepseek },
    ] })
    const rows = buildDelegatedSessionRows(snapshot)
    expect(rows.map(row => [row.title, row.status])).toEqual([
      ['Security review', 'paused'],
      ['UX review A', 'queued'],
      ['UX review B', 'running'],
      ['Performance review', 'review'],
      ['Started before cancel', 'idle'],
    ])
  })
})

it('keeps only unfinished changes and decision batches for the surfaces that show them', () => {
  const snapshot = withPendingSwitch('pending')
  snapshot.changes.push({ ...snapshot.changes[0]!, id: 'done', state: 'applied' }, { ...snapshot.changes[0]!, id: 'broken', state: 'failed', error: 'stop failed' })
  expect(delegationChangeSummaries(snapshot)).toEqual([
    { id: 'change', revision: 2, state: 'pending', sessionCount: 3 },
    { id: 'broken', revision: 2, state: 'failed', sessionCount: 3, error: 'stop failed' },
  ])
  expect(delegationDecisionBatches(snapshot)).toEqual([])
  snapshot.batches[0]!.state = 'review'
  expect(delegationDecisionBatches(snapshot).map(batch => batch.id)).toEqual(['batch'])
})
