import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('BrowserUseRow arms per message, switches target when selected, and renders inside RunToggles & ChatComposer for Antigravity', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let slots = [], cursor = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }] },
      useMemo: fn => fn(), useCallback: fn => fn, useEffect: () => {}, useRef: current => ({ current }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: {}, Linking: {}, Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-linear-gradient'))}, () => ({ LinearGradient: 'LinearGradient' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({
      Button: 'Button', Icon: 'Icon', InlineError: 'InlineError', Mono: 'Mono', Segmented: 'Segmented', Sheet: 'Sheet', Spinner: 'Spinner', Switch: 'Switch', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String, useTheme: () => ({ colors: {}, shadows: {}, dark: false, scheme: 'light' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./chatMaterials'))}, () => ({ pickChatMaterial: async () => [] }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/BringSheet'))}, () => ({ BringSheet: 'BringSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(import.meta.resolve('./chat/ImagePreview'))}, () => ({ ImagePreview: 'ImagePreview' }))
    mock.module(${JSON.stringify(import.meta.resolve('../core/useVoiceDictation'))}, () => ({ useVoiceDictation: () => ({ phase: 'idle', live: false, issue: null, pendingText: null }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../core/usePromptOptimize'))}, () => ({
      usePromptOptimize: () => ({
        phase: 'idle', optimizing: false, restoreSnapshot: null, notice: null, issue: null,
        optimize() {}, cancel() {}, restore() {}, edited() {}, dismissRestore() {}, dismissNotice() {}, dismissIssue() {},
      }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./ComputerUseControl'))}, () => ({
      ComputerUseRow: 'ComputerUseRow',
      ComputerUseConsent: 'ComputerUseConsent',
    }))

    const { BrowserUseRow } = require(${JSON.stringify(import.meta.resolve('./BrowserUseControl'))})
    const { RunToggles } = require(${JSON.stringify(import.meta.resolve('./compose/RunToggles'))})
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }

    let selectCount = 0, targetChanged = null
    const browser = {
      enabled: true,
      available: true,
      preferredTarget: 'auto',
      busy: false,
      error: '',
      consentOpen: false,
      refresh() {},
      selectForMessage(done) { selectCount++; done() },
      confirmConsent() {},
      cancelConsent() {},
      setTarget(next) { targetChanged = next; browser.preferredTarget = next },
    }

    // 1. BrowserUseRow toggles per-message selection and shows target Segmented when selected
    const rowState = { selected: false }
    let nodes = flatten(BrowserUseRow({ browser, selected: rowState.selected, onSelected: value => { rowState.selected = value } }))
    const sw = nodes.find(node => node.type === 'Switch' && node.props?.label === '操作浏览器')
    assert.ok(sw)
    assert.equal(sw.props.disabled, false)
    assert.equal(nodes.some(node => node.type === 'Segmented'), false, 'target picker stays hidden while unselected')
    sw.props.onValueChange(true)
    assert.equal(selectCount, 1)
    assert.equal(rowState.selected, true)

    nodes = flatten(BrowserUseRow({ browser, selected: rowState.selected, onSelected: value => { rowState.selected = value } }))
    const seg = nodes.find(node => node.type === 'Segmented')
    assert.ok(seg, 'target picker renders once Browser Use is selected')
    seg.props.onChange('workspace')
    assert.equal(targetChanged, 'workspace')

    // 2. RunToggles renders Agent 团队, 操作浏览器, and ComputerUseRow together in Antigravity mode
    cursor = 0; slots = []
    const toggleNodes = flatten(RunToggles({
      visible: true,
      client: null,
      team: false,
      onTeam: () => {},
      lean: false,
      antigravity: true,
      browser,
      browserSelected: true,
      onBrowserSelected: () => {},
      computer: { enabled: false, refresh: () => {} },
      computerSelected: false,
      onComputerSelected: () => {},
      accepted: false,
      onAccept: () => {},
    }))
    assert.equal(toggleNodes.some(node => node.type === 'Switch' && node.props?.label === 'Agent 团队'), true)
    assert.equal(toggleNodes.some(node => node.type === 'Switch' && node.props?.label === '操作浏览器'), true)
    assert.equal(toggleNodes.some(node => node.type === 'ComputerUseRow'), true)

    // 3. ChatComposer shows Browser Use pill with active target and forwards props to BringSheet
    cursor = 0; slots = []
    let disarmed = false
    const composerNodes = flatten(ChatComposer({
      client: null,
      runtime: { providerId: 'antigravity-acp', modelId: 'gemini-4-neon' },
      draft: '打开页面检查',
      onDraft: () => {},
      references: [],
      onReferences: () => {},
      attachments: [],
      onAttachments: () => {},
      team: false,
      onTeam: () => {},
      browser,
      browserUse: true,
      onBrowserUse: value => { if (!value) disarmed = true },
      computer: { enabled: false, refresh: () => {} },
      lean: false,
      empty: false,
      busy: false,
      disabled: false,
      run: { label: 'Antigravity', risk: 'normal' },
      onOpenRun: () => {},
      onSend: () => {},
      onError: () => {},
    }))
    const browserPill = composerNodes.find(node => node.props?.accessibilityLabel === '关闭这条消息的操作浏览器')
    assert.ok(browserPill, 'armed Browser Use must show a removable pill in the composer')
    assert.equal(
      composerNodes.some(node => node.props?.children === '浏览器 · 工作区'),
      true,
      'pill displays the selected browser target'
    )
    browserPill.props.onPress()
    assert.equal(disarmed, true)
    const bring = composerNodes.find(node => node.type === 'BringSheet')
    assert.equal(bring.props.browser, browser)
    assert.equal(bring.props.browserUse, true)
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})

test('BringSheet mounts BrowserUseConsent inline inside DetentSheet overlay and resets consent on close', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let slots = [], cursor = 0, effects = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }] },
      useMemo: fn => fn(),
      useEffect(fn) { effects.push(fn) },
      useRef: current => ({ current }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', Pressable: 'Pressable', TextInput: 'TextInput' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({
      ...Object.fromEntries(['Button', 'Callout', 'Dot', 'Icon', 'InlineError', 'Mono', 'Segmented', 'Sheet', 'Spinner', 'Switch'].map(name => [name, name])),
      useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./DetentSheet'))}, () => ({ DetentSheet: 'DetentSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ConnectorIcon'))}, () => ({ ConnectorIcon: 'ConnectorIcon' }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/recentStore'))}, () => ({ recentRepository: { load: async () => [], record: async () => {} } }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/useBringExtras'))}, () => ({ useBringExtras: () => ({ agents: [], connectors: [], workflows: [] }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/RunToggles'))}, () => ({ RunToggles: 'RunToggles' }))
    const { BringSheet } = require(${JSON.stringify(import.meta.resolve('./compose/BringSheet'))})
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    let cancelled = 0
    const browser = {
      enabled: false, available: true, preferredTarget: 'auto', busy: false, error: '', consentOpen: true,
      refresh() {}, selectForMessage() {}, confirmConsent() {}, cancelConsent() { cancelled++ }, setTarget() {},
    }
    const baseProps = {
      visible: true, onClose() {}, client: null, workDir: '/fixture', lean: false, candidates: [], loading: false, error: '',
      references: [], draft: '', picking: null, onPick() {}, team: false, onTeam() {}, browser, browserUse: false, onBrowserUse() {},
      computer: { supported: true, enabled: false, busy: false, refresh() {}, selectForMessage() {} }, onComputerSelected() {}, onApply() {},
    }
    cursor = 0
    const sheet = BringSheet(baseProps)
    assert.equal(sheet.type, 'DetentSheet')
    assert.equal(sheet.props.overlayOpen, true)
    const overlayNodes = flatten(sheet.props.overlay)
    const inlineSheet = overlayNodes.find(node => node.type === 'Sheet')
    assert.ok(inlineSheet, 'BrowserUseConsent must mount inside DetentSheet overlay')
    assert.equal(inlineSheet.props.inline, true, 'BrowserUseConsent must use inline overlay instead of nested native Modal')
    const toggles = flatten(sheet).find(node => node.type === 'RunToggles')
    assert.equal(toggles.props.renderBrowserConsent, false, 'RunToggles must not mount a second modal copy')
    sheet.props.onOverlayClose()
    assert.equal(cancelled, 1)

    // Closing BringSheet cancels any pending Browser Use consent
    effects = []
    cursor = 0
    BringSheet({ ...baseProps, visible: false })
    effects.forEach(fn => fn())
    assert.equal(cancelled, 2)
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
