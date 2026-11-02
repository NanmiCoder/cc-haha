import { describe, expect, test } from 'bun:test'
import {
  cleanSuggestionCandidate,
  countSuggestionWords,
  isUserStartedCommand,
  shouldFilterSuggestion,
} from './promptSuggestion.js'

const filtered = (suggestion: string) =>
  shouldFilterSuggestion(suggestion, 'user_intent', 'sdk')

describe('countSuggestionWords', () => {
  test('counts Han characters as half a word and keeps whitespace words whole', () => {
    expect(countSuggestionWords('运行测试')).toBe(2)
    expect(countSuggestionWords('提交')).toBe(1)
    expect(countSuggestionWords('run the tests')).toBe(3)
    expect(countSuggestionWords('跑一下 npm test')).toBe(4)
    expect(countSuggestionWords('   ')).toBe(0)
  })
})

describe('cleanSuggestionCandidate', () => {
  test('strips labels and wrapper tags models add around the suggestion', () => {
    expect(cleanSuggestionCandidate('建议：运行测试')).toBe('运行测试')
    expect(cleanSuggestionCandidate('Suggestion: run the tests')).toBe('run the tests')
    expect(cleanSuggestionCandidate('<suggestion>commit this</suggestion>')).toBe('commit this')
    expect(cleanSuggestionCandidate('  push it  ')).toBe('push it')
  })

  test('keeps text whose closing tag does not wrap the whole candidate', () => {
    const nested = '<result>a</result> and <result>b</result>'
    expect(cleanSuggestionCandidate(nested)).toBe(nested)
  })
})

describe('shouldFilterSuggestion', () => {
  test('keeps natural Chinese next steps', () => {
    expect(filtered('运行测试')).toBe(false)
    expect(filtered('提交并推送')).toBe(false)
    expect(filtered('提交')).toBe(false)
  })

  test('rejects Chinese meta, evaluative, Claude-voice and multi-sentence output', () => {
    expect(filtered('好')).toBe(true)
    expect(filtered('完成了')).toBe(true)
    expect(filtered('没有建议')).toBe(true)
    expect(filtered('（沉默）')).toBe(true)
    expect(filtered('谢谢')).toBe(true)
    expect(filtered('看起来不错')).toBe(true)
    expect(filtered('让我来运行测试')).toBe(true)
    expect(filtered('运行测试。然后提交')).toBe(true)
  })

  test('rejects reworded "stay silent" replies in CJK', () => {
    for (const meta of ['保持沉默', '暂无建议', '不需要建议', '没有明显的下一步', '沈黙します']) {
      expect(filtered(meta)).toBe(true)
    }
    expect(filtered('跑一下测试再提交')).toBe(false)
  })

  test('keeps the English rules', () => {
    expect(filtered('run the tests')).toBe(false)
    expect(filtered('yes')).toBe(false)
    expect(filtered('/commit')).toBe(false)
    expect(filtered('maybe')).toBe(true)
    expect(filtered('looks good')).toBe(true)
    expect(filtered("I'll run the tests")).toBe(true)
    expect(filtered('Run the tests. Then commit')).toBe(true)
    expect(filtered('one two three four five six seven eight nine ten eleven twelve thirteen')).toBe(true)
  })
})

describe('isUserStartedCommand', () => {
  test('only typed prompts count as user-started', () => {
    expect(isUserStartedCommand({ mode: 'prompt' })).toBe(true)
    expect(isUserStartedCommand({ mode: 'prompt', origin: { kind: 'human' } } as never)).toBe(true)
    expect(isUserStartedCommand({ mode: 'prompt', isMeta: true })).toBe(false)
    expect(isUserStartedCommand({ mode: 'task-notification' })).toBe(false)
    expect(isUserStartedCommand({ mode: 'prompt', origin: { kind: 'channel', server: 'scheduled-task' } } as never)).toBe(false)
    // Teammate mail and host notices sent as SDK user messages.
    expect(isUserStartedCommand({ mode: 'prompt', isSynthetic: true })).toBe(false)
  })
})
