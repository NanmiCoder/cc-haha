import { describe, expect, it } from 'vitest'
import { capabilityLabel, hasCapabilitySentence, parseUserMessageSegments } from './userMessageCapabilities'

// Literal copies of what capabilityMentionService.ts sends; the server test
// `capability mention model text readers` parses the producer's own output.
const SKILL = 'Use the Skill tool with skill: "frontend-design" for this request.'
const PLUGIN_SKILL = 'Use the Skill tool with skill: "office:documents" for this request.'
const PLUGIN = 'Use the enabled plugin "amap@official" for this request. Available skill identities: ["amap:route"]. '
  + 'MCP server identities: ["plugin:amap:maps"]. Invoke skills using the Skill tool and use only tools currently '
  + 'available from these servers. If unavailable or authentication is required, report that; do not install or authenticate automatically.'

describe('parseUserMessageSegments', () => {
  it('returns plain text unchanged', () => {
    expect(parseUserMessageSegments('Fix the login bug')).toEqual([{ type: 'text', text: 'Fix the login bug' }])
    expect(hasCapabilitySentence('Fix the login bug')).toBe(false)
  })

  it('turns skill and plugin sentences into pills where the user placed them', () => {
    expect(parseUserMessageSegments(`${SKILL} 做个落地页，用 ${PLUGIN} 查路线`)).toEqual([
      { type: 'skill', id: 'frontend-design', label: 'frontend-design', modelText: SKILL },
      { type: 'text', text: ' 做个落地页，用 ' },
      { type: 'plugin', id: 'amap@official', label: 'amap', modelText: PLUGIN },
      { type: 'text', text: ' 查路线' },
    ])
  })

  it('labels a plugin skill without its owner and keeps the full identity', () => {
    expect(parseUserMessageSegments(PLUGIN_SKILL)).toEqual([
      { type: 'skill', id: 'office:documents', label: 'documents', modelText: PLUGIN_SKILL },
    ])
    expect(capabilityLabel('plugin', 'amap@official')).toBe('amap')
  })

  it('reads the composer fallback sentence for a pill without model text', () => {
    const fallback = 'Use skill "Design" for this request.'
    expect(parseUserMessageSegments(`${fallback} go`)[0]).toEqual({ type: 'skill', id: 'Design', label: 'Design', modelText: fallback })
  })

  it('marks a leading slash command and the CLI skill breadcrumb', () => {
    expect(parseUserMessageSegments('/commit 只提交 docs')).toEqual([
      { type: 'command', name: '/commit' },
      { type: 'text', text: ' 只提交 docs' },
    ])
    expect(parseUserMessageSegments('/plugin:review')).toEqual([{ type: 'command', name: '/plugin:review' }])
    expect(parseUserMessageSegments('Skill(frontend-design)')).toEqual([
      { type: 'skill', id: 'frontend-design', label: 'frontend-design', modelText: '' },
    ])
  })

  it('does not mistake paths or mid-text slashes for commands', () => {
    expect(parseUserMessageSegments('/usr/bin/env is missing')).toEqual([{ type: 'text', text: '/usr/bin/env is missing' }])
    expect(parseUserMessageSegments('run /commit later')).toEqual([{ type: 'text', text: 'run /commit later' }])
    expect(parseUserMessageSegments('/ alone')).toEqual([{ type: 'text', text: '/ alone' }])
  })
})
