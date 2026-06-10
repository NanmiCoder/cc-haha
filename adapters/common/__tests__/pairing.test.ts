import { describe, expect, it } from 'bun:test'
import { isPaired } from '../pairing.js'

describe('pairing platform support', () => {
  it('checks DingTalk paired users with the same shared access rule', () => {
    expect(isPaired('dingtalk', 'staff-1', {
      dingtalk: {
        pairedUsers: [{ userId: 'staff-1', displayName: 'DingTalk User', pairedAt: Date.now() }],
        allowedUsers: [],
      },
    })).toBe(true)
  })

  it('keeps empty DingTalk allow and pair lists closed by default', () => {
    expect(isPaired('dingtalk', 'staff-1', {
      dingtalk: {
        pairedUsers: [],
        allowedUsers: [],
      },
    })).toBe(false)
  })

  it('checks WhatsApp paired users with the same shared access rule', () => {
    expect(isPaired('whatsapp', '15551234567@s.whatsapp.net', {
      whatsapp: {
        pairedUsers: [{ userId: '15551234567@s.whatsapp.net', displayName: 'WhatsApp User', pairedAt: Date.now() }],
        allowedUsers: [],
      },
    })).toBe(true)
  })
})
