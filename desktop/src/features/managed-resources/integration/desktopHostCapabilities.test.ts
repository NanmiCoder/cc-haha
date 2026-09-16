import { describe, expect, it } from 'vitest'
import { browserHost } from '../../../lib/desktopHost/browserHost'
import { getDesktopHost } from '../../../lib/desktopHost'

describe('DesktopHost managed resources capabilities (M2.1)', () => {
  it('exposes hostManagement, conceptKnowledge, and conversationContext capabilities on DesktopHost', () => {
    const host = getDesktopHost()
    expect('hostManagement' in host.capabilities).toBe(true)
    expect('conceptKnowledge' in host.capabilities).toBe(true)
    expect('conversationContext' in host.capabilities).toBe(true)
  })

  it('declares all three capabilities as false in browserHost', () => {
    expect(browserHost.capabilities.hostManagement).toBe(false)
    expect(browserHost.capabilities.conceptKnowledge).toBe(false)
    expect(browserHost.capabilities.conversationContext).toBe(false)
  })

  it('explicitly returns UNAUTHORIZED / UNAVAILABLE in browserHost without pretending success or returning fake data', async () => {
    expect(browserHost.hostManagement).toBeDefined()
    const capResult = await browserHost.hostManagement.getCapabilities()
    expect(capResult.ok).toBe(false)
    if (!capResult.ok) {
      expect(capResult.error.code).toBe('UNAVAILABLE')
    }

    const listResult = await browserHost.hostManagement.listHosts()
    expect(listResult.ok).toBe(false)
    if (!listResult.ok) {
      expect(listResult.error.code).toBe('UNAVAILABLE')
    }

    const hostResult = await browserHost.hostManagement.getHost('dummy-id')
    expect(hostResult.ok).toBe(false)
    if (!hostResult.ok) {
      expect(hostResult.error.code).toBe('UNAVAILABLE')
    }

    expect(browserHost.conceptKnowledge).toBeDefined()
    const conceptResult = await browserHost.conceptKnowledge.listConcepts()
    expect(conceptResult.ok).toBe(false)
    if (!conceptResult.ok) {
      expect(conceptResult.error.code).toBe('UNAVAILABLE')
    }

    expect(browserHost.conversationContext).toBeDefined()
    const contextResult = await browserHost.conversationContext.getSelection('test-session')
    expect(contextResult.ok).toBe(false)
    if (!contextResult.ok) {
      expect(contextResult.error.code).toBe('UNAVAILABLE')
    }
  })
})
