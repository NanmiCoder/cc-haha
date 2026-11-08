import { describe, expect, test } from 'bun:test'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForContent,
  roughTokenCountEstimationForMessages,
} from './tokenEstimation.js'
import { OPENAI_REASONING_ENVELOPE_PREFIX } from '../utils/openAIReasoningEnvelope.js'

describe('roughTokenCountEstimationForContent', () => {
  test('does not treat OpenAI encrypted reasoning bytes as plaintext tokens', () => {
    const data = `${OPENAI_REASONING_ENVELOPE_PREFIX}${JSON.stringify({
      id: 'rs_test',
      summary: [{ type: 'summary_text', text: 'visible summary' }],
      encrypted_content: 'x'.repeat(400_000),
    })}`

    expect(
      roughTokenCountEstimationForContent([
        { type: 'redacted_thinking', data },
      ]),
    ).toBe(4)
  })

  test('keeps estimating non-OpenAI redacted thinking payloads', () => {
    expect(
      roughTokenCountEstimationForContent([
        { type: 'redacted_thinking', data: 'x'.repeat(400) },
      ]),
    ).toBe(100)
  })

  test('counts CJK text at about one token per character instead of chars/4', () => {
    // 1,000 Han characters. Real tokenizers charge ~0.6-1.2 tokens each; the
    // chars/4 rule said 250, which kept relays without usage from ever
    // reaching the auto-compact threshold.
    const chinese = '上下文压缩估算'.repeat(100) + '中文'.repeat(150)
    expect(chinese.length).toBe(1_000)

    expect(roughTokenCountEstimationForContent(chinese)).toBe(1_000)
    expect(
      roughTokenCountEstimationForContent([{ type: 'text', text: chinese }]),
    ).toBe(1_000)
  })

  test('covers kana, hangul, extension A, compatibility ideographs and full-width punctuation', () => {
    const samples = [
      'ひらがな', // hiragana
      'カタカナ', // katakana
      '한국어문장', // hangul syllables
      '㐀䶵', // CJK extension A
      '豈﨎', // CJK compatibility ideographs
      '，。！？「」、（）', // full-width / CJK punctuation
    ]
    for (const sample of samples) {
      expect(roughTokenCountEstimationForContent(sample)).toBe(sample.length)
    }
  })

  test('keeps chars/4 for non-CJK text and splits mixed text by script', () => {
    expect(roughTokenCountEstimationForContent('x'.repeat(400))).toBe(100)
    // 400 ASCII chars -> 100 tokens, plus 200 Han characters -> 200 tokens.
    const mixed = 'abcd'.repeat(100) + '中文'.repeat(100)
    expect(roughTokenCountEstimationForContent(mixed)).toBe(300)
  })

  test('counts CJK inside tool input, tool results and thinking', () => {
    const chinese = '读取文件'.repeat(50) // 200 Han characters
    expect(
      roughTokenCountEstimationForContent([
        { type: 'tool_result', tool_use_id: 't1', content: chinese },
      ]),
    ).toBe(200)
    expect(
      roughTokenCountEstimationForContent([
        { type: 'thinking', thinking: chinese, signature: '' },
      ]),
    ).toBe(200)
    // name + JSON input: 'Bash' + '{"command":"' + 200 Han + '"}'
    // -> (4 + 12 + 2) ASCII chars / 4 rounds to 5, plus 200.
    expect(
      roughTokenCountEstimationForContent([
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: chinese } },
      ]),
    ).toBe(205)
  })

  test('leaves the image and document estimate unchanged', () => {
    expect(
      roughTokenCountEstimationForContent([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: '图'.repeat(10_000) },
        },
      ]),
    ).toBe(2_000)
  })
})

describe('roughTokenCountEstimationForMessages', () => {
  test('does not underestimate a Chinese conversation', () => {
    const question = '请帮我分析这个项目的上下文压缩为什么没有触发'.repeat(20)
    const answer = '自动压缩依赖用量统计，中转站没有返回用量时只能靠本地估算。'.repeat(20)
    const messages = [
      { type: 'user', message: { content: question } },
      { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
    ]

    expect(roughTokenCountEstimationForMessages(messages)).toBe(
      question.length + answer.length,
    )
  })
})

describe('roughTokenCountEstimation', () => {
  test('keeps its chars/bytesPerToken semantics for file size limits', () => {
    // File-read limits depend on this exact ratio; only the conversation
    // estimate is CJK-aware.
    expect(roughTokenCountEstimation('中文'.repeat(100))).toBe(50)
    expect(roughTokenCountEstimation('中文'.repeat(100), 2)).toBe(100)
  })
})
