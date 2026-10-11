import { describe, expect, it } from 'vitest'
import { deriveSessionTitle, displaySessionTitle } from './sessionTitle'

describe('deriveSessionTitle', () => {
  it('uses slash command metadata without showing raw XML tags', () => {
    const raw = [
      '<command-message>frontend-design</command-message>',
      '<command-name>/frontend-design</command-name>',
      '<command-args>@website 重新设计首页</command-args>',
    ].join('\n')

    expect(deriveSessionTitle(raw)).toBe('/frontend-design @website 重新设计首页')
  })
})

describe('displaySessionTitle', () => {
  it('shows a real title as it is', () => {
    expect(displaySessionTitle('Fix login redirect', '未命名')).toBe('Fix login redirect')
  })

  it.each(['Untitled Session', 'New Session', '', '  ', null, undefined])('shows the localized fallback for the placeholder %s', (title) => {
    expect(displaySessionTitle(title, '未命名')).toBe('未命名')
  })
})
