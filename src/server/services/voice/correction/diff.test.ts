import { describe, expect, test } from 'bun:test'
import {
  cleanCorrectionOutput,
  correctionSimilarity,
  isPlausibleCorrection,
  normalizeDictationText,
  rebuildCorrection,
  tokenize,
} from './diff.js'

/** Every change must be exactly what sits at its offsets in the rebuilt text. */
function expectConsistent(result: ReturnType<typeof rebuildCorrection>) {
  for (const change of result.changes) {
    expect(result.text.slice(change.start, change.end)).toBe(change.to)
  }
}

describe('tokenize', () => {
  test('keeps Latin/digit runs with inner . - _ + # whole and splits CJK, spaces and punctuation', () => {
    expect(tokenize('用gpt-5.3-codex和C++写Node.js, ok_1 C#。').map(token => token.text)).toEqual([
      '用', 'gpt-5.3-codex', '和', 'C++', '写', 'Node.js', ',', ' ', 'ok_1', ' ', 'C#', '。',
    ])
  })
})

describe('rebuildCorrection (benchmark cases)', () => {
  test('"agent brother" becomes "Agent Browser" without the spaces the model added around it', () => {
    const raw = '开源的这一个agent brother skills之前我也经常用它'
    const result = rebuildCorrection(raw, '开源的这一个 Agent Browser skills 之前我也经常用它')

    expect(result.text).toBe('开源的这一个Agent Browser skills之前我也经常用它')
    expect(result.changes).toEqual([{ from: 'agent brother', to: 'Agent Browser', start: 6, end: 19 }])
    expectConsistent(result)
  })

  test('"coded" becomes "Codex" and an inserted space inside a word is a real change', () => {
    const raw = 'gonet一段时间之后，我就把它卸载了。第一个就是在coded中去用A。'
    const result = rebuildCorrection(raw, 'go net一段时间之后，我就把它卸载了。第一个就是在Codex中去用A。')

    expect(result.text).toBe('go net一段时间之后，我就把它卸载了。第一个就是在Codex中去用A。')
    expect(result.changes.map(({ from, to }) => [from, to])).toEqual([['gonet', 'go net'], ['coded', 'Codex']])
    expectConsistent(result)
  })

  test('keeps the recognized punctuation and spacing next to every term fix', () => {
    const raw = '发给自己的agent，我这边用的是harmes。那大家如果用的是什么codeds啊，work body啊，C code都可以他。'
    const model = '发给自己的 Agent，我这边用的是 Harness。那大家如果用的是什么 Codex 啊，WorkBuddy 啊，CC、code 都可以他。'
    const result = rebuildCorrection(raw, model)

    expect(result.text).toBe('发给自己的Agent，我这边用的是Harness。那大家如果用的是什么Codex啊，WorkBuddy啊，CC code都可以他。')
    expect(result.changes.map(({ from, to }) => [from, to])).toEqual([
      ['agent', 'Agent'],
      ['harmes', 'Harness'],
      ['codeds', 'Codex'],
      ['work body', 'WorkBuddy'],
      ['C', 'CC'],
    ])
    expectConsistent(result)
  })
})

describe('rebuildCorrection (Chinese the model adds next to a term)', () => {
  test('a word added in front of a fixed term is dropped (real DeepSeek Flash output)', () => {
    const raw = 'agentbrother这个skill的时候，我经常会遇到内存泄露的问题'
    const result = rebuildCorrection(raw, '用 Agent browser 这个 skill 的时候，我经常会遇到内存泄露的问题')
    expect(result.text).toBe('Agent browser这个skill的时候，我经常会遇到内存泄露的问题')
    expect(result.changes.map(change => [change.from, change.to])).toEqual([['agentbrother', 'Agent browser']])
    expectConsistent(result)
  })

  test('a sentence the model finished after the last term is dropped', () => {
    const result = rebuildCorrection('我们今天要讨论的是怎么在项目里面用 cloud', '我们今天要讨论的是怎么在项目里面用 Claude Code 来写代码')
    expect(result.text).toBe('我们今天要讨论的是怎么在项目里面用 Claude Code')
    expect(result.changes.map(change => [change.from, change.to])).toEqual([['cloud', 'Claude Code']])
  })

  test('an English word the model translated into Chinese stays as dictated', () => {
    const result = rebuildCorrection('打开 browser 看一下', '打开 浏览器 看一下')
    expect(result.text).toBe('打开 browser 看一下')
    expect(result.changes).toEqual([])
  })

  test('Chinese that was itself misheard stays replaceable', () => {
    const agent = rebuildCorrection('去完成A进的交给他的任务', '去完成Agent交给他的任务')
    expect(agent.changes.map(change => [change.from, change.to])).toEqual([['A进的', 'Agent']])
    const zhipu = rebuildCorrection('质补GM5.3的效果', '智谱GLM5.3的效果')
    expect(zhipu.changes.map(change => [change.from, change.to])).toEqual([['质补GM5.3', '智谱GLM5.3']])
    expectConsistent(agent)
    expectConsistent(zhipu)
  })
})

describe('rebuildCorrection (what gets dropped)', () => {
  test('a punctuation-only or spacing-only answer changes nothing', () => {
    const raw = '好的,我们开始吧 先看 README'
    expect(rebuildCorrection(raw, '好的，我们开始吧。先看README。')).toEqual({ text: raw, changes: [] })
  })

  test('punctuation the model swapped at the edge of a fix stays as recognized', () => {
    const result = rebuildCorrection('用codex,然后提交', '用 Codex，然后提交')
    expect(result).toEqual({ text: '用Codex,然后提交', changes: [{ from: 'codex', to: 'Codex', start: 1, end: 6 }] })
  })

  test('bare insertions and deletions are not term fixes', () => {
    expect(rebuildCorrection('后来在我用过一', '后来在我用过一次之后').changes).toEqual([])
    expect(rebuildCorrection('嗯那个我们看一下', '我们看一下')).toEqual({ text: '嗯那个我们看一下', changes: [] })
    expect(rebuildCorrection('看一下', '纠正后：看一下')).toEqual({ text: '看一下', changes: [] })
  })

  test('a case-only fix is still a change', () => {
    const result = rebuildCorrection('打开Claude code然后', '打开 Claude Code 然后')
    expect(result.text).toBe('打开Claude Code然后')
    expect(result.changes).toEqual([{ from: 'code', to: 'Code', start: 9, end: 13 }])
  })

  test('identical text has no changes', () => {
    expect(rebuildCorrection('没有术语的一句话', '没有术语的一句话')).toEqual({ text: '没有术语的一句话', changes: [] })
  })

  test('offsets stay right after an earlier fix changes length', () => {
    const result = rebuildCorrection('克劳德扣的和coded都在用', 'Claude Code和Codex都在用')
    expect(result.text).toBe('Claude Code和Codex都在用')
    expect(result.changes.map(({ from, to }) => [from, to])).toEqual([['克劳德扣的', 'Claude Code'], ['coded', 'Codex']])
    expectConsistent(result)
  })
})

describe('output guard', () => {
  test('accepts a sentence with a few terms fixed, including a one-word dictation', () => {
    expect(isPlausibleCorrection('开源的这一个agent brother skills之前我也经常用它', '开源的这一个 Agent Browser skills 之前我也经常用它')).toBe(true)
    expect(isPlausibleCorrection('coded', 'Codex')).toBe(true)
    expect(isPlausibleCorrection('我在用迪普西克写代码', '我在用 DeepSeek 写代码')).toBe(true)
  })

  test('cannot tell a whole-utterance transliteration from an answer, so it keeps the original', () => {
    // Nothing of the input survives in either case; the composer inserts the recognized text.
    expect(isPlausibleCorrection('迪普西克', 'DeepSeek')).toBe(false)
  })

  test('rejects an answer to the dictated question', () => {
    const raw = '帮我看一下这个函数为什么报错'
    expect(isPlausibleCorrection(raw, '这个函数报错可能是因为参数类型不对，你可以检查一下传入的参数。')).toBe(false)
    // Same length, different sentence: caught by similarity rather than length.
    expect(isPlausibleCorrection('今天天气怎么样', '今天是晴天，气温二十度')).toBe(false)
    expect(isPlausibleCorrection('几点了', '现在是下午')).toBe(false)
    expect(correctionSimilarity('几点了', '现在是下午')).toBe(0)
  })

  test('rejects empty, much shorter and much longer answers', () => {
    expect(isPlausibleCorrection('一段正常长度的识别结果', '')).toBe(false)
    expect(isPlausibleCorrection('一段正常长度的识别结果文本', '一段')).toBe(false)
    expect(isPlausibleCorrection('短句', '短句短句短句短句短句')).toBe(false)
  })
})

describe('cleanCorrectionOutput', () => {
  test('unwraps a code fence and quotes the recognized text did not have, then flattens lines', () => {
    expect(cleanCorrectionOutput('```text\n“用 Codex\n写代码”\n```', '用coded写代码')).toBe('用 Codex 写代码')
    expect(cleanCorrectionOutput('"Agent Browser"', 'agent brother')).toBe('Agent Browser')
  })

  test('keeps quotes that were part of the dictation', () => {
    expect(cleanCorrectionOutput('"Codex" 很好用', '"coded" 很好用')).toBe('"Codex" 很好用')
    expect(cleanCorrectionOutput('「Codex」', '「coded」')).toBe('「Codex」')
  })

  test('normalizes like the composer', () => {
    expect(normalizeDictationText('  第一行 \n\n 第二行\r\n')).toBe('第一行 第二行')
  })
})
