import { describe, expect, it } from 'vitest'
import { extractRestoredUserDisplay } from '@/stores/chatStore'
import { withAgentTeamRequest } from './agentTeamRequest'
import {
  getBrowserUseRequestInstruction,
  stripBrowserUseRequest,
  withBrowserUseRequest,
} from './browserUseRequest'

describe('browser use request', () => {
  it('wraps and strips the browser instruction with target metadata', () => {
    for (const target of ['auto', 'workspace', 'chrome'] as const) {
      const sent = withBrowserUseRequest('Open modeldial.com', target)
      expect(sent).toContain(`<browser-use-request target="${target}">`)
      expect(sent).toContain(getBrowserUseRequestInstruction(target))
      expect(sent.endsWith('\n\nOpen modeldial.com')).toBe(true)
      expect(stripBrowserUseRequest(sent)).toEqual({
        content: 'Open modeldial.com',
        requested: true,
        target,
      })
    }
  })

  it('defaults bare browser-use-request tags to auto and leaves plain or unclosed text untouched', () => {
    expect(stripBrowserUseRequest('<browser-use-request>\nUse Browser Use\n</browser-use-request>\n\nCheck page')).toEqual({
      content: 'Check page',
      requested: true,
      target: 'auto',
    })
    expect(stripBrowserUseRequest('plain text')).toEqual({ content: 'plain text', requested: false })
    const quoted = 'Why does <browser-use-request> show up in logs?'
    expect(stripBrowserUseRequest(quoted)).toEqual({ content: quoted, requested: false })
  })

  it('restores clean user text while preserving modelContent for live and reloaded bubbles', () => {
    const sent = withBrowserUseRequest('Open modeldial.com', 'workspace')
    expect(extractRestoredUserDisplay(sent)).toMatchObject({
      content: 'Open modeldial.com',
      modelContent: sent,
    })
  })

  it('strips combined Agent Team and Browser Use blocks in either order', () => {
    const combinedA = withAgentTeamRequest(withBrowserUseRequest('@"/repo/README.md" check page', 'chrome'))
    const restoredA = extractRestoredUserDisplay(combinedA)
    expect(restoredA.content).toBe('check page')
    expect(restoredA.modelContent).toBe(combinedA)
    expect(restoredA.attachments).toHaveLength(1)

    const combinedB = withBrowserUseRequest(withAgentTeamRequest('check page'), 'workspace')
    const restoredB = extractRestoredUserDisplay(combinedB)
    expect(restoredB.content).toBe('check page')
    expect(restoredB.modelContent).toBe(combinedB)
  })
})
