import { describe, expect, it } from 'vitest'
import { mergeLiveSessionStatus, type LiveActivityMap } from './sessionLiveStatus'

const sorted = (ids: ReadonlySet<string>) => [...ids].sort()

describe('mergeLiveSessionStatus', () => {
  it('adds sessions only the server knows about', () => {
    const live: LiveActivityMap = new Map([['from-phone', 'running'], ['from-im', 'waiting']])

    const status = mergeLiveSessionStatus({ runningIds: ['here'], attentionIds: [], connectedIds: ['here'] }, live)

    expect(sorted(status.runningIds)).toEqual(['from-phone', 'here'])
    expect(sorted(status.attentionIds)).toEqual(['from-im'])
  })

  it('trusts a connected socket over a poll that is up to one interval old', () => {
    // The request was answered here a moment ago; the server's last answer
    // still says waiting.
    const live: LiveActivityMap = new Map([['answered', 'waiting']])

    const status = mergeLiveSessionStatus({ runningIds: ['answered'], attentionIds: [], connectedIds: ['answered'] }, live)

    expect(sorted(status.attentionIds)).toEqual([])
    expect(sorted(status.runningIds)).toEqual(['answered'])
  })

  it('reads a released session from the server even though the chat store still has its record', () => {
    // Dropped from the warm set while running: its last chat state is stale.
    const live: LiveActivityMap = new Map([['released', 'waiting']])

    const status = mergeLiveSessionStatus({ runningIds: ['released'], attentionIds: [], connectedIds: [] }, live)

    expect(sorted(status.attentionIds)).toEqual(['released'])
    expect(sorted(status.runningIds)).toEqual([])
  })

  it('never reports a session as both waiting and running', () => {
    const live: LiveActivityMap = new Map([['card', 'running']])

    const status = mergeLiveSessionStatus({ runningIds: ['card'], attentionIds: ['card'], connectedIds: [] }, live)

    expect(sorted(status.attentionIds)).toEqual(['card'])
    expect(sorted(status.runningIds)).toEqual([])
  })
})
