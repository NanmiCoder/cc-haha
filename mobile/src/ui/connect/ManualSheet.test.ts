import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

test('scanner connection form retains native parent boundaries as fields and keyboard change', () => {
  // Isolate native-module substitutes from the other Bun suites. Render the real
  // component's element tree: this verifies the RN layout contract, not Android's
  // mounting engine (the addViewAt regression still needs the device smoke path).
  const dir = mkdtempSync(join(tmpdir(), 'mobile-sheet-render-'))
  const report = join(dir, 'report.json')
  const script = `
    import { writeFileSync } from 'node:fs'
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    let keyboard = false
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      View: 'View', Pressable: 'Pressable', useWindowDimensions: () => ({ height: 844 }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      Button: 'Button', FieldRow: 'FieldRow', Footnote: 'Footnote', Group: 'Group',
      Icon: 'Icon', InlineError: 'InlineError', Segmented: 'Segmented', Separator: 'Separator',
      Sheet: 'Sheet', Spinner: 'Spinner', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./motion'))}, () => ({ useKeyboardShown: () => keyboard }))
    const { ManualSheet } = require(${JSON.stringify(import.meta.resolve('./ManualSheet'))})
    const noop = () => {}
    const base = {
      visible: true, onClose: noop, mode: 'lan', onModeChange: noop,
      name: 'QA desktop', onNameChange: noop, address: '', onAddressChange: noop,
      token: '', onTokenChange: noop, onPasteToken: noop, busy: false,
      status: '', error: '', onConnect: noop, onCancel: noop, onRescan: noop,
    }
    const rendered = []
    for (const state of [
      {},
      { address: 'http://127.0.0.1:3457/?h5Token=fixture-only' },
      { address: 'http://127.0.0.1:3457/?h5Token=fixture-only', busy: true },
      { mode: 'remote', address: 'https://fixture.invalid/#pair=fixture-only' },
    ]) {
      for (keyboard of [false, true]) {
        const sheet = ManualSheet({ ...base, ...state })
        const surface = sheet.props.children
        assert.equal(surface.type, 'View')
        assert.equal(surface.props.collapsable, false, 'form parent must remain native during sheet transitions')
        assert.equal(surface.props.collapsableChildren, false, 'segmented and field groups must keep their own parents')
        assert.equal(surface.props.children[0].type, 'Segmented')
        assert.equal(surface.props.children[1].type, 'Group')
        assert.equal(surface.props.children[0].props.value, state.mode ?? 'lan')
        assert.equal(surface.props.children[0].props.disabled, state.busy ?? false)
        if (keyboard) assert.equal(surface.props.style.minHeight, 0)
        rendered.push({ keyboard, busy: state.busy ?? false, mode: state.mode ?? 'lan' })
      }
    }
    writeFileSync(${JSON.stringify(report)}, JSON.stringify(rendered))
  `
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' })
    expect(JSON.parse(readFileSync(report, 'utf8'))).toHaveLength(8)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
