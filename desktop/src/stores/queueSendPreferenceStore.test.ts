import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SEND_QUEUED_MESSAGES_AT_ONCE,
  normalizeSendQueuedMessagesAtOnce,
  persistSendQueuedMessagesAtOnce,
  QUEUE_SEND_AT_ONCE_STORAGE_KEY,
  readSendQueuedMessagesAtOnce,
  sendsQueuedMessagesAtOnce,
  useQueueSendPreferenceStore,
} from './queueSendPreferenceStore'

describe('queued prompt send preference', () => {
  beforeEach(() => {
    localStorage.clear()
    useQueueSendPreferenceStore.setState({
      sendQueuedMessagesAtOnce: DEFAULT_SEND_QUEUED_MESSAGES_AT_ONCE,
    })
  })

  it('defaults to sequential sending, matching the issue request', () => {
    expect(DEFAULT_SEND_QUEUED_MESSAGES_AT_ONCE).toBe(false)
    expect(readSendQueuedMessagesAtOnce()).toBe(false)
    expect(sendsQueuedMessagesAtOnce()).toBe(false)
  })

  it('only treats an explicit on value as batch mode', () => {
    expect(normalizeSendQueuedMessagesAtOnce(true)).toBe(true)
    expect(normalizeSendQueuedMessagesAtOnce('1')).toBe(true)
    expect(normalizeSendQueuedMessagesAtOnce('true')).toBe(true)
    expect(normalizeSendQueuedMessagesAtOnce('0')).toBe(false)
    expect(normalizeSendQueuedMessagesAtOnce('false')).toBe(false)
    expect(normalizeSendQueuedMessagesAtOnce(undefined)).toBe(false)
    expect(normalizeSendQueuedMessagesAtOnce({ send: true })).toBe(false)
  })

  it('persists through its own storage key', () => {
    useQueueSendPreferenceStore.getState().setSendQueuedMessagesAtOnce(true)

    expect(localStorage.getItem(QUEUE_SEND_AT_ONCE_STORAGE_KEY)).toBe('1')
    expect(readSendQueuedMessagesAtOnce()).toBe(true)
    expect(sendsQueuedMessagesAtOnce()).toBe(true)

    useQueueSendPreferenceStore.getState().setSendQueuedMessagesAtOnce(false)
    expect(localStorage.getItem(QUEUE_SEND_AT_ONCE_STORAGE_KEY)).toBe('0')
    expect(readSendQueuedMessagesAtOnce()).toBe(false)
  })

  it('falls back safely when storage is blocked', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readSendQueuedMessagesAtOnce(blocked)).toBe(false)
    expect(() => persistSendQueuedMessagesAtOnce(true, blocked)).not.toThrow()
  })
})
