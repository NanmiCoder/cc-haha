import { describe, expect, it } from 'vitest'
import {
  migratePendingInputRecovery, PENDING_INPUT_RECOVERY_KEY,
  PENDING_INPUT_RECOVERY_MAX_BYTES, PENDING_INPUT_RECOVERY_MAX_ENTRIES,
  readPendingInputRecovery, removePendingInputRecovery, savePendingInputError, savePendingInputRecovery,
} from './pendingInputRecovery'
import type { UIMessage } from '../types/chat'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

function human(id = 'input-1'): Extract<UIMessage, { type: 'user_text' }> {
  return {
    id, type: 'user_text', content: '  My exact prompt\n\n下一段  ', timestamp: 123,
    modelContent: 'Referenced source\n\nMy exact prompt',
    attachments: [{ type: 'file', name: 'source.ts', path: '/fixture/source.ts', lineStart: 9, quote: 'exact quoted line' }],
    sessionReferences: [{ sessionId: 'reference' }],
  }
}

describe('pending input recovery storage', () => {
  it('migrates an old profile with no recovery key and unversioned pending input forward', () => {
    expect(migratePendingInputRecovery(null)).toEqual({ version: 1, entries: [] })
    const target = memoryStorage()
    target.setItem('unrelated-settings', '{"private":"untouched"}')
    target.setItem(PENDING_INPUT_RECOVERY_KEY, JSON.stringify({ entries: [{ sessionId: 's', input: human() }] }))
    expect(readPendingInputRecovery('s', 'unconfirmed', target)[0]).toMatchObject(human())
    expect(savePendingInputRecovery('s', human('input-2'), target)).toBe(true)
    expect(JSON.parse(target.getItem(PENDING_INPUT_RECOVERY_KEY)!)).toMatchObject({ version: 1, entries: [{ input: { id: 'input-1' } }, { input: { id: 'input-2' } }] })
    expect(target.getItem('unrelated-settings')).toBe('{"private":"untouched"}')
  })

  it('round trips full prompt, attachments and failure without persisting runtime settings', () => {
    const target = memoryStorage()
    expect(savePendingInputRecovery('s', {
      ...human(), provider: { apiKey: 'do-not-store-this' }, pendingPermissions: ['private-approval'],
    } as never, target)).toBe(true)
    savePendingInputError('s', { id: 'error-1', code: 'INTERNAL_ERROR', message: 'Metadata file missing', timestamp: 456 }, undefined, target)
    const raw = target.getItem(PENDING_INPUT_RECOVERY_KEY)!
    expect(raw).not.toContain('do-not-store-this')
    expect(raw).not.toContain('private-approval')
    expect(readPendingInputRecovery('s', 'unconfirmed', target)).toMatchObject([
      { ...human(), localHistoryRecovery: 'input' },
      { id: 'error-1', type: 'error', code: 'INTERNAL_ERROR', message: 'Metadata file missing', localHistoryRecovery: 'error' },
    ])
  })

  it('restores unconfirmed sends for review without representing them as acknowledged or automatically queued', () => {
    const target = memoryStorage()
    savePendingInputRecovery('s', { ...human(), awaitingReplay: true, optimisticQueued: true }, target)
    const messages = readPendingInputRecovery('s', 'Review before resending', target)
    expect(messages[0]).not.toHaveProperty('awaitingReplay')
    expect(messages[0]).not.toHaveProperty('optimisticQueued')
    expect(messages[1]).toMatchObject({ type: 'error', code: 'INPUT_DELIVERY_UNCONFIRMED', message: 'Review before resending' })
    expect(readPendingInputRecovery('other', 'unconfirmed', target)).toEqual([])
  })

  it('does not truncate oversized prompts or evict older failed inputs when capacity is reached', () => {
    const target = memoryStorage()
    for (let index = 0; index < PENDING_INPUT_RECOVERY_MAX_ENTRIES; index++) {
      expect(savePendingInputRecovery('s', human(String(index)), target)).toBe(true)
    }
    const original = target.getItem(PENDING_INPUT_RECOVERY_KEY)
    expect(savePendingInputRecovery('s', human('overflow'), target)).toBe(false)
    expect(target.getItem(PENDING_INPUT_RECOVERY_KEY)).toBe(original)
    expect(savePendingInputRecovery('s', { ...human('0'), content: '长'.repeat(PENDING_INPUT_RECOVERY_MAX_BYTES) }, target)).toBe(false)
    expect(target.getItem(PENDING_INPUT_RECOVERY_KEY)).toBe(original)
  })

  it('fails closed on quota errors or future schemas without destroying the existing copy', () => {
    const target = memoryStorage()
    savePendingInputRecovery('s', human(), target)
    const original = target.getItem(PENDING_INPUT_RECOVERY_KEY)
    expect(savePendingInputRecovery('s', human('new'), { ...target, setItem: () => { throw new Error('QuotaExceededError') } })).toBe(false)
    expect(target.getItem(PENDING_INPUT_RECOVERY_KEY)).toBe(original)
    const future = JSON.stringify({ version: 9, entries: [{ sessionId: 's', input: human() }] })
    target.setItem(PENDING_INPUT_RECOVERY_KEY, future)
    expect(savePendingInputRecovery('s', human('new'), target)).toBe(false)
    expect(target.getItem(PENDING_INPUT_RECOVERY_KEY)).toBe(future)
  })

  it('removes only confirmed input IDs or explicitly cleared sessions', () => {
    const target = memoryStorage()
    savePendingInputRecovery('s', human('confirmed'), target)
    savePendingInputRecovery('s', human('still-pending'), target)
    savePendingInputRecovery('other', human('other'), target)
    removePendingInputRecovery('s', new Set(['confirmed']), target)
    expect(readPendingInputRecovery('s', 'unconfirmed', target).filter((message) => message.type === 'user_text')).toMatchObject([{ id: 'still-pending' }])
    removePendingInputRecovery('s', undefined, target)
    expect(readPendingInputRecovery('s', 'unconfirmed', target)).toEqual([])
    expect(readPendingInputRecovery('other', 'unconfirmed', target)[0]).toMatchObject({ id: 'other' })
  })
})
