import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

// Native rendering still needs the device smoke test. This isolated renderer
// checks the real row styles and FlatList geometry without mocking other suites.
function checkLayout(kind: 'diff' | 'code', fontScale: number) {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useMemo: (fn) => fn(), useState: () => [600, () => {}],
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      AccessibilityInfo: {}, ActivityIndicator: 'ActivityIndicator', Animated: {}, Easing: {},
      FlatList: 'FlatList', Modal: 'Modal', Platform: { OS: 'android', select: (v) => v.android },
      Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
      Text: 'Text', useWindowDimensions: () => ({ width: 402, height: 874, fontScale: ${fontScale} }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({}) }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-svg'))}, () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({ router: {} }))
    mock.module(${JSON.stringify(import.meta.resolve('../KeyboardViewport'))}, () => ({ KeyboardViewport: 'KeyboardViewport' }))
    mock.module(${JSON.stringify(import.meta.resolve('../icons'))}, () => ({ Icon: 'Icon' }))
    mock.module(${JSON.stringify(import.meta.resolve('../theme'))}, () => ({ useTheme: () => ({ colors: {} }) }))
    const { DiffView } = require(${JSON.stringify(import.meta.resolve('../kit'))})
    const { CodeView } = require(${JSON.stringify(import.meta.resolve('./CodeView'))})
    const text = 'HELLO from approved Android 中文';
    const scale = ${fontScale}
    const lines = Array.from({length: 5000}, (_, index) => ({ kind: 'add', text, after: index + 1 }))
    const root = ${JSON.stringify(kind)} === 'diff'
      ? DiffView({ lines, virtualized: true })
      : CodeView({ content: Array(5000).fill(text).join('\\n'), language: 'plain' })
    const list = root.props.children.props.children
    assert.equal(list.type, 'FlatList')
    const layout = list.props.getItemLayout(null, 4999)
    const element = list.props.renderItem({ item: list.props.data[4999], index: 4999 })
    const row = typeof element.type === 'function' ? element.type(element.props) : element
    const style = Object.assign({}, ...[row.props.style].flat())
    // The scaled text must fit fully inside its row; scrolling to row 5000 must
    // use exactly that same height or virtualization will skip/overlap lines.
    assert.ok(style.height >= 21 * scale, 'large text must not be clipped by its row')
    assert.equal(layout.length, style.height)
    assert.equal(layout.offset, (${JSON.stringify(kind)} === 'diff' ? 6 : 10) + 4999 * style.height)
    if (scale === 1) assert.equal(style.height, 21)
    const children = row.props.children.flatMap((child) => child?.type === React.Fragment ? child.props.children : child)
    const code = children.at(-1)
    const codeStyle = Object.assign({}, ...[code.props.style].flat())
    assert.equal(codeStyle.fontSize, 12.5, 'native text scaling must not be applied twice')
    assert.equal(codeStyle.lineHeight, 21)
    const gutters = children.slice(0, -1).map((child) => Object.assign({}, ...[child.props.style].flat()).width)
    for (const gutter of gutters) assert.ok(gutter >= 4 * 12 * 0.6 * scale + 6, 'four digit line numbers must fit')
    // Width includes the full long row, two full-width glyphs, prefix, gutters,
    // and padding. Without scaling this silently wraps inside a one-line row.
    const glyphWidth = [...text].reduce((width, char) => width + (char.charCodeAt(0) > 0x2e7f ? 12.5 : 7.5), 0) * scale
    assert.ok(list.props.style.width >= gutters.reduce((a, b) => a + b, 0) + glyphWidth + 24, 'long scaled code line must remain horizontally scrollable')
  `
  execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

for (const kind of ['diff', 'code'] as const) {
  test(`${kind} keeps large text and the last virtualized row fully visible`, () => {
    expect(() => checkLayout(kind, 2)).not.toThrow()
  })
  test(`${kind} preserves default text size and row spacing`, () => {
    expect(() => checkLayout(kind, 1)).not.toThrow()
  })
}
