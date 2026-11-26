import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('ChatComposer and RunToggles hide team controls and pill when onTeam is omitted', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let state = [], cursor = 0
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState: initial => {
        const slot = cursor++
        if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
        return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
      },
      useEffect: () => {}, useCallback: fn => fn, useMemo: fn => fn(), useRef: current => ({ current }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Keyboard: {}, Linking: {}, Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-linear-gradient'))}, () => ({ LinearGradient: 'LinearGradient' }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({
      Button: 'Button', Icon: 'Icon', Mono: 'Mono', Sheet: 'Sheet', Spinner: 'Spinner', Switch: 'Switch', useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String }))
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
    const { ChatComposer } = require(${JSON.stringify(import.meta.resolve('./ChatComposer'))})
    const { RunToggles } = require(${JSON.stringify(import.meta.resolve('./compose/RunToggles'))})
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }

    // 1. ChatComposer without onTeam hides team pill even if team=true and passes team=false to BringSheet
    cursor = 0
    state = []
    const composerNodes = flatten(ChatComposer({
      client: null,
      draft: 'hello',
      onDraft: () => {},
      references: [],
      onReferences: () => {},
      attachments: [],
      onAttachments: () => {},
      team: true,
      onTeam: undefined,
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
    assert.equal(composerNodes.some(node => node.props?.accessibilityLabel === '关闭这条消息的 Agent 团队'), false)
    const bring = composerNodes.find(node => node.type === 'BringSheet')
    assert.equal(bring.props.team, false)
    assert.equal(bring.props.onTeam, undefined)

    // 2. RunToggles without onTeam hides the Agent 团队 Switch while keeping ComputerUseRow
    cursor = 0
    state = []
    const toggleNodes = flatten(RunToggles({
      visible: true,
      client: null,
      team: false,
      onTeam: undefined,
      lean: false,
      computer: { enabled: false, refresh: () => {} },
      computerSelected: false,
      onComputerSelected: () => {},
      accepted: false,
      onAccept: () => {},
    }))
    assert.equal(toggleNodes.some(node => node.type === 'Switch' && node.props?.label === 'Agent 团队'), false)
    assert.equal(toggleNodes.some(node => node.type === 'ComputerUseRow'), true)

    // 3. RunToggles with onTeam still renders the Agent 团队 Switch
    cursor = 0
    state = []
    const enabledNodes = flatten(RunToggles({
      visible: true,
      client: null,
      team: false,
      onTeam: () => {},
      lean: false,
      computer: { enabled: false, refresh: () => {} },
      computerSelected: false,
      onComputerSelected: () => {},
      accepted: false,
      onAccept: () => {},
    }))
    assert.equal(enabledNodes.some(node => node.type === 'Switch' && node.props?.label === 'Agent 团队'), true)

    // 4. Antigravity ChatComposer passes antigravity=true to BringSheet and suppresses @ skill trigger
    cursor = 0
    state = []
    const agNodes = flatten(ChatComposer({
      client: null,
      runtime: { providerId: 'antigravity-acp', modelId: 'gemini-4-neon' },
      draft: '@review',
      onDraft: () => {},
      references: [],
      onReferences: () => {},
      attachments: [],
      onAttachments: () => {},
      team: false,
      onTeam: () => {},
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
    const agBring = agNodes.find(node => node.type === 'BringSheet')
    assert.equal(agBring.props.antigravity, true, 'ChatComposer forwards antigravity=true to BringSheet')
    assert.equal(agNodes.some(node => node.props?.children === '没有匹配的斜杠命令' || node.props?.children === '没有匹配的技能或命令'), false, 'Antigravity suppresses @ mention candidate card')

    // 5. RunToggles in Antigravity mode keeps Agent 团队 enabled without depending on Claude settings
    cursor = 0
    state = []
    const agToggleNodes = flatten(RunToggles({
      visible: true,
      client: null,
      team: false,
      onTeam: () => {},
      lean: false,
      antigravity: true,
      computer: { enabled: false, refresh: () => {} },
      computerSelected: false,
      onComputerSelected: () => {},
      accepted: false,
      onAccept: () => {},
    }))
    const agTeamSwitch = agToggleNodes.find(node => node.type === 'Switch' && node.props?.label === 'Agent 团队')
    assert.ok(agTeamSwitch)
    assert.equal(agTeamSwitch.props.disabled, false, 'Antigravity Agent 团队 switch is not gated on Claude settings')
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})

test('Antigravity chat sessions expose team toggle and format armed prompts as /swarm instead of Claude team envelopes', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, slots = [], sent = []
    const native = { send(message) { sent.push(message); return true }, scrollToOffset() {} }
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const id = cursor++
        if (!(id in slots)) {
          const value = typeof initial === 'function' ? initial() : initial
          slots[id] = value === 'connecting' ? 'ready' : value
        }
        const value = slots[id]
        if (value && Array.isArray(value.items)) {
          return [{ ...value, runtime: { providerId: 'antigravity-acp', modelId: 'agent-default' } }, next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }]
        }
        return [value, next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }]
      },
      useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial === null ? native : initial }; return slots[id] },
      useMemo: fn => fn(), useCallback: fn => fn, useEffect: () => {}, useEffectEvent: fn => fn,
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ View: 'View', FlatList: 'FlatList', Platform: { OS: 'ios' }, AppState: {} }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 44, bottom: 34 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({ router: {}, useFocusEffect: () => {}, useLocalSearchParams: () => ({ id: 'ag-chat', host: 'fixture' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-clipboard'))}, () => ({}))
    mock.module(${JSON.stringify(import.meta.resolve('expo-crypto'))}, () => ({ getRandomValues: array => array, randomUUID: () => 'fixture-uuid' }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-network'))}, () => ({ addNetworkStateListener: () => ({ remove() {} }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../state/api'))}, () => ({ hostLinkFor: () => undefined, nativeSocketFactory: () => ({}), watchDeviceNetwork: () => () => {} }))
    mock.module(${JSON.stringify(import.meta.resolve('../state/AppContext'))}, () => ({ useApp: () => ({ drafts: new Map([['fixture:ag-chat', 'inspect repo']]) }), useConnection: () => ({ client: null, host: { id: 'fixture', name: 'Fixture', auth: 'lan' } }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../state/DashboardContext'))}, () => ({ useDashboard: () => ({ snapshot: null }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../core/useComputerUse'))}, () => ({ useComputerUse: () => ({ enabled: false }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../core/sessionActivity'))}, () => ({ teamMembersAllStopped: () => true, useSessionActivity: () => ({ runningCount: 0 }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({
      ...Object.fromEntries(['ActionMenu', 'Button', 'Callout', 'Card', 'FloatingButton', 'InlineError', 'Mono', 'NavBar', 'ScreenView', 'Spinner', 'Toast'].map(name => [name, name])),
      goBack() {}, useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String }))
    const views = [
      [${JSON.stringify(import.meta.resolve('./KeyboardViewport'))}, ['KeyboardViewport']],
      [${JSON.stringify(import.meta.resolve('./Approval'))}, ['Approval']],
      [${JSON.stringify(import.meta.resolve('./team/TeamPlanCard'))}, ['TeamPlanCard']],
      [${JSON.stringify(import.meta.resolve('./team/TeamPlanSheet'))}, ['TeamPlanSheet']],
      [${JSON.stringify(import.meta.resolve('./ChatComposer'))}, ['ChatComposer']],
      [${JSON.stringify(import.meta.resolve('./Message'))}, ['Message']],
      [${JSON.stringify(import.meta.resolve('./compose/RunSheet'))}, ['RunSheet']],
      [${JSON.stringify(import.meta.resolve('./activity/ActivityCapsule'))}, ['ActivityCapsule']],
      [${JSON.stringify(import.meta.resolve('./activity/ActivitySheet'))}, ['ActivitySheet']],
      [${JSON.stringify(import.meta.resolve('./activity/WorkflowHistorySheet'))}, ['WorkflowHistorySheet']],
      [${JSON.stringify(import.meta.resolve('./chat/StatusCaption'))}, ['StatusCaption']],
      [${JSON.stringify(import.meta.resolve('./SessionChangesCard'))}, ['SessionChangesCard']],
      [${JSON.stringify(import.meta.resolve('./chat/StepGroup'))}, ['StepGroup', 'TurnFold']],
      [${JSON.stringify(import.meta.resolve('./chat/QueuedMessages'))}, ['QueuedMessages']],
      [${JSON.stringify(import.meta.resolve('./chat/OlderHistoryStatus'))}, ['OlderHistoryStatus']],
      [${JSON.stringify(import.meta.resolve('./chat/MessageMenu'))}, ['MessageMenu']],
      [${JSON.stringify(import.meta.resolve('./chat/sheets'))}, ['ConfirmSheet', 'EditResendSheet', 'RenameSheet', 'SelectTextSheet']],
    ]
    for (const [path, names] of views) mock.module(path, () => Object.fromEntries(names.map(name => [name, name])))
    mock.module(${JSON.stringify(import.meta.resolve('./activity/useNow'))}, () => ({ useNow: () => 1 }))
    mock.module(${JSON.stringify(import.meta.resolve('./team/useTeamPlan'))}, () => ({ useTeamPlan: () => ({ plan: null, pending: null, error: '', edit: async () => true, act: async () => true }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./chat/ContextSheet'))}, () => ({ ContextMenuHeader: 'ContextMenuHeader', ContextSheet: 'ContextSheet', useContextInspection: () => ({}) }))
    const { parkComposer } = require(${JSON.stringify(import.meta.resolve('./chat/queue'))})
    parkComposer('fixture:ag-chat', { attachments: [], references: [], team: true })
    const { default: Chat } = require(${JSON.stringify(import.meta.resolve('../app/chat/[id]'))})
    function find(node, type) {
      if (!node || typeof node !== 'object') return
      if (node.type === type) return node
      for (const child of [node.props?.children].flat(Infinity)) { const match = find(child, type); if (match) return match }
    }
    cursor = 0
    const screen = Chat()
    const tree = screen.type(screen.props)
    // Second pass catches render-time setTeam(false) regressions that mutate state slots during pass 1.
    cursor = 0
    const screen2 = Chat()
    const tree2 = screen2.type(screen2.props)
    const composer = find(tree2, 'ChatComposer')
    assert.ok(tree && composer)
    assert.equal(composer.props.team, true, 'Antigravity chat preserves armed team state across renders')
    assert.equal(typeof composer.props.onTeam, 'function', 'Antigravity chat exposes onTeam')
    assert.equal(composer.props.onSend(), true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].content, '/swarm inspect repo', 'Antigravity armed team must send /swarm instead of Claude Agent Team envelope')
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})

test('NewSession keeps onTeam when Antigravity engine is selected and formats armed prompts as /swarm', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, slots = [], effects = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const id = cursor++
        if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
        return [slots[id], next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }]
      },
      useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial }; return slots[id] },
      useMemo: fn => fn(), useCallback: fn => fn,
      useEffect(fn) { effects.push(fn) },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Platform: { OS: 'ios' }, ScrollView: 'ScrollView', View: 'View' }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ SafeAreaView: 'SafeAreaView' }))
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({ router: { replace() {} }, useFocusEffect: () => {}, useLocalSearchParams: () => ({ host: 'fixture' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ChatComposer'))}, () => ({ ChatComposer: 'ChatComposer' }))
    mock.module(${JSON.stringify(import.meta.resolve('./compose/RunSheet'))}, () => ({ RunSheet: 'RunSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('./newtask/WherePage'))}, () => ({ WherePage: 'WherePage' }))
    mock.module(${JSON.stringify(import.meta.resolve('./newtask/TargetCard'))}, () => ({ TargetCard: 'TargetCard' }))
    mock.module(${JSON.stringify(import.meta.resolve('./KeyboardViewport'))}, () => ({ KeyboardViewport: 'KeyboardViewport' }))
    mock.module(${JSON.stringify(import.meta.resolve('./kit'))}, () => ({
      Button: 'Button', Callout: 'Callout', InlineError: 'InlineError', Segmented: 'Segmented', TextButton: 'TextButton',
      goBack() {}, useColors: () => ({}),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./theme'))}, () => ({ errorText: String }))
    mock.module(${JSON.stringify(import.meta.resolve('../core/useComputerUse'))}, () => ({ useComputerUse: () => ({ enabled: false }) }))
    const client = {
      host: { id: 'fixture', auth: 'lan' },
      async get(path) {
        if (path.startsWith('/api/sessions/recent-projects')) return { projects: [] }
        if (path === '/api/providers') return { activeId: null, antigravity: { status: 'ready', models: [{ id: 'agent-default', name: 'Default' }] } }
        if (path === '/api/models/current') return { model: { id: 'claude-sonnet-4-5' } }
        if (path === '/api/effort') return { level: 'high' }
        if (path === '/api/models') return { models: [{ id: 'claude-sonnet-4-5', name: 'Sonnet 4.5' }] }
        if (path === '/api/permissions/mode') return { mode: 'default' }
        return {}
      },
    }
    mock.module(${JSON.stringify(import.meta.resolve('../state/AppContext'))}, () => ({
      useApp: () => ({ drafts: new Map(), registry: { selectedId: 'fixture' } }),
      useConnection: () => ({ host: { id: 'fixture', name: 'Fixture', auth: 'lan' }, client, error: '' }),
    }))
    const { buildComposerMessage } = require(${JSON.stringify(import.meta.resolve('../core/chatComposer'))})
    assert.equal(buildComposerMessage('audit repo', [], true, { antigravity: true }).content, '/swarm audit repo')
    assert.equal(buildComposerMessage('/swarm audit repo', [], true, { antigravity: true }).content, '/swarm audit repo')
    const { default: NewSession } = require(${JSON.stringify(import.meta.resolve('../app/new'))})
    function find(node, type) {
      if (!node || typeof node !== 'object') return
      if (node.type === type) return node
      for (const child of [node.props?.children].flat(Infinity)) { const match = find(child, type); if (match) return match }
    }
    const render = () => { cursor = 0; const screen = NewSession(); return screen.type(screen.props) }
    render()
    effects.splice(0).forEach(fn => fn())
    await new Promise(resolve => setTimeout(resolve, 10))
    let tree = render()
    const seg = find(tree, 'Segmented')
    assert.ok(seg, 'engine selector renders when Antigravity is installed')
    assert.equal(typeof find(tree, 'ChatComposer').props.onTeam, 'function', 'cc-haha engine keeps onTeam')
    seg.props.onChange('antigravity')
    tree = render()
    const composer = find(tree, 'ChatComposer')
    assert.equal(typeof composer.props.onTeam, 'function', 'Antigravity engine keeps onTeam')
    composer.props.onTeam(true)
    tree = render()
    assert.equal(find(tree, 'ChatComposer').props.team, true, 'Antigravity engine arms team')
    find(tree, 'Segmented').props.onChange('cc-haha')
    tree = render()
    assert.equal(typeof find(tree, 'ChatComposer').props.onTeam, 'function', 'switching back keeps onTeam')
  `
  try {
    execFileSync(process.execPath, ['--no-env-file', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
})
