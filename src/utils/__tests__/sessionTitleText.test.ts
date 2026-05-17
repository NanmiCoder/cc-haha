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

})
