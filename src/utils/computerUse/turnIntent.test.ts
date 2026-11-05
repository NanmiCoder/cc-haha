import { describe, expect, test } from 'bun:test'
import { requiresComputerUse } from './turnIntent.js'

describe('explicit Computer Use turns', () => {
  test.each([
    '打开网易云音乐app播放喜欢你，邓紫棋版本，再点击歌词播放 使用computer use',
    '请用Computer Use打开网易云音乐',
    'Open Calculator via Computer Use.',
    'Please use Computer Use to open Calculator.',
    '打开设置。\n使用computer-use',
    '/computer-use open Calculator',
    '$computer-use 打开计算器',
    'Use the Skill tool with skill: "computer-use" for this request.\n\nOpen Calculator.',
    '@"C:/temp/reference.png" 请用电脑操作打开计算器',
  ])('recognizes an instruction in %j', value => {
    expect(requiresComputerUse({ mode: 'prompt', value })).toBe(true)
  })

  test.each([
    'Explain Computer Use.',
    'How do I use Computer Use?',
    '不要使用 Computer Use',
    '打开它，不要 使用 computer use',
    '请比较使用 Computer Use 的方案',
    'Explain `use computer use`.',
    '> Use Computer Use to open Calculator.',
    'Explain this example.\n```text\nUse Computer Use to open Calculator\n```',
    'This example is incomplete.\n~~~\nUse Computer Use to open Calculator',
    '/rename Use Computer Use',
    '/computer-use-extra',
    'Use computer-use.ts as a reference',
    '@"C:/temp/use computer use" Explain the attachment.',
  ])('leaves ordinary prompts alone in %j', value => {
    expect(requiresComputerUse({ mode: 'prompt', value })).toBe(false)
  })

  test('uses authored text from image turns and ignores synthetic input', () => {
    const value = [
      { type: 'text', text: '用 computer use 操作计算器' },
      { type: 'image', source: { type: 'base64', data: 'fixture', media_type: 'image/png' } },
      { type: 'text', text: '[Image source: fixture.png]' },
    ] as const
    expect(requiresComputerUse({ mode: 'prompt', value: [...value] })).toBe(true)
    expect(requiresComputerUse({ mode: 'prompt', value: [...value], isMeta: true })).toBe(false)
    expect(requiresComputerUse({ mode: 'prompt', value: [...value], origin: { kind: 'channel', server: 'fixture' } })).toBe(false)
  })
})
