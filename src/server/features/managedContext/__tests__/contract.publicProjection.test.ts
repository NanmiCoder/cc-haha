import { describe, expect, it } from 'bun:test'
import {
  composeUserContent,
  MANAGED_CONTEXT_BLOCK_BEGIN,
} from '../composer.js'
import {
  projectManagedContextContent,
  projectManagedContextText,
} from '../../../../services/managedContext/blockFormat.js'
import { extractReplayUserText } from '../../../ws/cliMessageParsing.js'
import { extractTranscriptUserTitle } from '../../../services/localIndex/transcriptReducer.js'
import { extractSearchableSegments } from '../../../services/localIndex/searchContentProjector.js'

const BODY = 'show deployment status'
const SECRET = 'fake-host-password-123'

function composed(): string {
  return composeUserContent({
    userText: BODY,
    contextText: JSON.stringify({ password: SECRET, host: 'prod-1' }),
  }).content
}

describe('M8 public managed-context projection', () => {
  it('strips the whole managed block and preserves only the user body', () => {
    const projected = projectManagedContextText(composed())
    expect(projected).toEqual({ ok: true, text: BODY, hadManagedContext: true })
    expect(JSON.stringify(projected)).not.toContain(SECRET)
  })

  it('projects text blocks without mutating non-text blocks', () => {
    const tool = { type: 'tool_result', tool_use_id: 't1', content: 'ok' }
    const projected = projectManagedContextContent([
      { type: 'text', text: composed() },
      tool,
    ])
    expect(projected.ok).toBe(true)
    if (!projected.ok) return
    expect(projected.content).toEqual([{ type: 'text', text: BODY }, tool])
    expect(JSON.stringify(projected.content)).not.toContain(SECRET)
  })

  it('fails closed for a malformed managed marker', () => {
    expect(projectManagedContextText(`${MANAGED_CONTEXT_BLOCK_BEGIN}\n${SECRET}`)).toEqual({ ok: false })
  })

  it('keeps replay, fallback title and search on the same public body', () => {
    const raw = composed()
    expect(extractReplayUserText({ isReplay: true, message: { content: raw } })).toBe(BODY)
    expect(extractTranscriptUserTitle(raw)).toBe(BODY)
    expect(extractSearchableSegments({
      type: 'user',
      message: { role: 'user', content: raw },
    })).toEqual([{ role: 'user', text: BODY }])
  })

  it('drops malformed managed content from replay/title/search', () => {
    const malformed = `${MANAGED_CONTEXT_BLOCK_BEGIN}\n${SECRET}`
    expect(extractReplayUserText({ isReplay: true, message: { content: malformed } })).toBeNull()
    expect(extractTranscriptUserTitle(malformed)).toBeNull()
    expect(extractSearchableSegments({
      type: 'user',
      message: { role: 'user', content: malformed },
    })).toEqual([])
  })
})
