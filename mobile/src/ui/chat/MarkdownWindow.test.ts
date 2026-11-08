import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'
import { parseMarkdown } from './markdown'

/**
 * 真实的 Markdown 组件和长按浮起的 MessageMenu：一条消息挂多少块、展开到哪为止、
 * 流式追加时结尾窗口的 key 是否稳定。安卓上每块都是占 Java 堆的原生视图，挂太多会 OOM 闪退。
 * 测试用的长文本经 stdin 交给子进程（脚本里读作 texts）：Linux 单个命令行参数上限 128KB。
 */
function run(body: string, texts: Record<string, string> = {}) {
  const script = `
    import { mock } from 'bun:test'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, slots = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const id = cursor++
        if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
        return [slots[id], next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }]
      },
      useMemo: fn => fn(), useRef: initial => ({ current: initial }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: {}, Modal: 'Modal', Platform: { OS: 'android' }, Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View',
      useWindowDimensions: () => ({ width: 412, height: 915 }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Callout: 'Callout', CodeBlock: 'CodeBlock', Icon: 'Icon', InlineCode: 'InlineCode', Spinner: 'Spinner', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/chatComposer'))}, () => ({ visibleMessageText: text => text }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/userMessageDisplay'))}, () => ({ userMessageDisplay: () => ({ capabilities: [], text: '' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./ImagePreview'))}, () => ({ ImagePreview: 'ImagePreview' }))
    mock.module(${JSON.stringify(import.meta.resolve('./attachmentPreview'))}, () => ({ attachmentImageSelection() {}, attachmentImageUri() {} }))
    mock.module(${JSON.stringify(import.meta.resolve('../compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(import.meta.resolve('../webChrome'))}, () => ({ simulatedPhoneChrome: false }))
    const { Markdown } = require(${JSON.stringify(import.meta.resolve('../Message'))})
    const { MessageMenu } = require(${JSON.stringify(import.meta.resolve('./MessageMenu'))})
    const flat = node => [node?.props?.children].flat(Infinity).filter(child => child && typeof child === 'object')
    const textOf = node => typeof node === 'string' ? node : [node?.props?.children].flat(Infinity).map(textOf).join('')
    /** 渲染一次 Markdown（同一个实例沿用 state），拆出已挂的块和中间的省略行。 */
    function markdown(props) {
      cursor = 0
      const children = flat(Markdown(props))
      const blocks = children.filter(child => /^[ht]\\d+$/.test(String(child.key)))
      const gap = children.find(child => !/^[ht]\\d+$/.test(String(child.key)))
      return {
        count: blocks.length,
        tail: Object.fromEntries(blocks.filter(child => String(child.key).startsWith('t')).map(child => [child.key, child.props.text])),
        gap: gap && { pressable: gap.type === 'Pressable', label: textOf(gap), press: gap.props.onPress },
      }
    }
    function fresh() { slots = []; cursor = 0 }
    const texts = JSON.parse(await Bun.stdin.text())
    const out = {}
    ${body}
    console.log(JSON.stringify(out))
  `
  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      input: JSON.stringify(texts),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return JSON.parse(String(stdout).trim().split('\n').at(-1) ?? '{}')
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
}

const article = [
  ...Array.from({ length: 150 }, (_, index) => `第 ${index} 段正文。`),
  ...Array.from({ length: 10 }, (_, list) => Array.from({ length: 6 }, (_, item) => `- 列表 ${list}-${item}`).join('\n')),
  '| 模型 | 输入 | 输出 |\n| --- | --- | --- |\n' + Array.from({ length: 12 }, (_, row) => `| m${row} | 1 | 2 |`).join('\n'),
].join('\n\n')
// 真实会话里出现过的形状：模型把 "<br>\n\n" 重复了约 3.2 万次。
const degenerate = '实跑已启动。\n\n' + '<br>\n\n'.repeat(32000) + '结论在最后。'

test('普通长回复整条渲染，没有折叠行', () => {
  const out = run(`
    fresh()
    const view = markdown({ text: texts.article })
    out.count = view.count
    out.gap = view.gap ?? null
  `, { article })
  expect(out.count).toBe(parseMarkdown(article).length)
  expect(out.gap).toBeNull()
})

test('超长回复只挂开头和结尾；展开三次后封顶，提示到电脑上看完整内容', () => {
  const out = run(`
    fresh()
    out.steps = []
    for (let tap = 0; tap < 5; tap++) {
      const view = markdown({ text: texts.degenerate })
      out.steps.push({ count: view.count, pressable: view.gap.pressable, label: view.gap.label })
      if (view.gap.pressable) view.gap.press()
    }
  `, { degenerate })
  expect(out.steps.map((step: { count: number }) => step.count)).toEqual([2000, 3500, 5000, 6500, 6500])
  expect(out.steps[0]).toEqual({ count: 2000, pressable: true, label: '… 中间还有 30002 段，点按展开' })
  expect(out.steps.at(-1)).toEqual({
    count: 6500,
    pressable: false,
    label: '… 中间还有 25502 段，太长了，完整内容请在电脑上查看',
  })
})

test('流式追加一段时，结尾窗口里已有的块 key 不变、内容不变', () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `第 ${index} 段`).join('\n\n')
  const out = run(`
    fresh()
    const before = markdown({ text: texts.before }).tail
    fresh()
    const after = markdown({ text: texts.after }).tail
    out.shared = Object.keys(before).filter(key => key in after)
    out.changed = out.shared.filter(key => before[key] !== after[key])
    out.added = Object.keys(after).filter(key => !(key in before)).map(key => after[key])
  `, { before: lines(2600), after: lines(2601) })
  expect(out.shared).toHaveLength(499)
  expect(out.changed).toEqual([])
  expect(out.added).toEqual(['第 2600 段'])
})

test('长按浮起的预览：普通长回复完整，超长回复受同样的上限且不能展开', () => {
  const out = run(`
    const layout = { x: 16, y: 120, width: 380, height: 600 }
    function preview(text) {
      cursor = 0
      const page = MessageMenu({ item: { id: 'm', type: 'assistant', text }, layout, actions: [], onAction() {}, onClose() {} })
      const find = node => {
        if (!node || typeof node !== 'object') return
        if (node.type === Markdown) return node
        for (const child of flat(node)) { const hit = find(child); if (hit) return hit }
      }
      fresh()
      return markdown(find(page).props)
    }
    const normal = preview(texts.article)
    out.normal = { count: normal.count, gap: normal.gap ?? null }
    const huge = preview(texts.degenerate)
    out.huge = { count: huge.count, pressable: huge.gap.pressable, label: huge.gap.label }
  `, { article, degenerate })
  expect(out.normal).toEqual({ count: parseMarkdown(article).length, gap: null })
  expect(out.huge).toEqual({ count: 2000, pressable: false, label: '… 中间还有 30002 段' })
})
