import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'
import { parseMarkdown } from './markdown'

/**
 * Real Markdown component and the long-press floating MessageMenu: how many blocks a message mounts, how far it can expand, 
 * and whether end-window keys are stable during streaming. On Android each block is a native view on the Java heap, and mounting too many causes an OOM crash.
 * Long test text is passed to the child process via stdin (read as texts in the script): Linux caps a single command-line argument at 128KB.
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
    /** Render Markdown once (the same instance keeps state), splitting out mounted blocks and the middle omission row. */
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
  ...Array.from({ length: 150 }, (_, index) => `Paragraph ${index} body.`),
  ...Array.from({ length: 10 }, (_, list) => Array.from({ length: 6 }, (_, item) => `- List ${list}-${item}`).join('\n')),
  '| Model | Input | Output |\n| --- | --- | --- |\n' + Array.from({ length: 12 }, (_, row) => `| m${row} | 1 | 2 |`).join('\n'),
].join('\n\n')
// A shape seen in a real session: the model repeated "<br>\n\n" about 32,000 times.
const degenerate = 'Real run started.\n\n' + '<br>\n\n'.repeat(32000) + 'Conclusion at the end.'

test('Normal long replies render in full without a collapsed row', () => {
  const out = run(`
    fresh()
    const view = markdown({ text: texts.article })
    out.count = view.count
    out.gap = view.gap ?? null
  `, { article })
  expect(out.count).toBe(parseMarkdown(article).length)
  expect(out.gap).toBeNull()
})

test('Very long replies mount only the beginning and end; capped after three expansions, with a hint to view the full content on the computer', () => {
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
  expect(out.steps[0]).toEqual({ count: 2000, pressable: true, label: '… 30002 more blocks in the middle, tap to expand' })
  expect(out.steps.at(-1)).toEqual({
    count: 6500,
    pressable: false,
    label: '… 25502 more blocks in the middle, too long; view the full content on the computer',
  })
})

test('When streaming appends a block, keys and content of blocks already in the end window stay the same', () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `Block ${index}`).join('\n\n')
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
  expect(out.added).toEqual(['Block 2600'])
})

test('Long-press floating preview: normal long replies are complete, very long replies have the same cap and cannot expand', () => {
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
  expect(out.huge).toEqual({ count: 2000, pressable: false, label: '… 30002 more blocks in the middle' })
})
