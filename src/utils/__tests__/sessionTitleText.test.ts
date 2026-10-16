import { describe, expect, test } from 'bun:test'
import { cleanSessionTitleSource } from '../sessionTitleText.js'

describe('sessionTitleText', () => {
  test('converts slash command XML metadata into a user-facing title source', () => {
    const raw = [
      '<command-message>frontend-design</command-message>',
      '<command-name>/frontend-design</command-name>',
      '<command-args>@website 重新设计首页</command-args>',
    ].join('\n')

    expect(cleanSessionTitleSource(raw)).toBe('/frontend-design @website 重新设计首页')
  })

  test('strips non-command internal XML wrappers from title sources', () => {
    expect(cleanSessionTitleSource('<ide_opened_file>secret.ts</ide_opened_file>\nFix login'))
      .toBe('Fix login')
  })

  test('shows a composer skill pill by name instead of its model instruction', () => {
    const raw = '<agent-team-request>\nUse an Agent Team for this request.\n</agent-team-request>\n\n'
      + 'Use the Skill tool with skill: "frontend-design" for this request. 做个落地页'
    expect(cleanSessionTitleSource(raw)).toBe('/frontend-design 做个落地页')
    expect(cleanSessionTitleSource('Use the Skill tool with skill: not-json for this request.'))
      .toBe('Use the Skill tool with skill: not-json for this request.')
  })

})
