import { describe, expect, it } from 'bun:test'
import { ConversationService } from '../services/conversationService.js'

describe('ConversationService permission profile', () => {
  it('always uses --dangerously-skip-permissions in SaaS mode', () => {
    const svc = new ConversationService()
    const args = (svc as any).getPermissionArgs('default', false) as string[]
    expect(args).toEqual(['--dangerously-skip-permissions'])
  })
})
