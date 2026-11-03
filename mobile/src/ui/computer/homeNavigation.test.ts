import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

/**
 * 选电脑、加电脑、移除电脑之后要退回栈里已有的首页。原来用 router.replace('/')，每次都在栈上
 * 多压一个首页（真机上 5000 个会话时每个首页约 2300 个原生视图），跟着每 3 秒的列表刷新重新渲染。
 * 这里跑真实页面和真实的 goHome，只把 expo-router 换成记录调用的替身。
 */
function run(body: string) {
  const script = `
    import { mock } from 'bun:test'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let cursor = 0, slots = []
    const navigation = []
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState(initial) {
        const id = cursor++
        if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
        return [slots[id], next => { slots[id] = typeof next === 'function' ? next(slots[id]) : next }]
      },
      useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial }; return slots[id] },
      useMemo: fn => fn(), useCallback: fn => fn, useEffect: () => {},
    }))
    const alerts = []
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Alert: { alert: (title, message, buttons) => alerts.push(buttons) },
      Animated: {}, PanResponder: {}, Platform: { OS: 'android' }, Pressable: 'Pressable', RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../theme'))}, () => ({ errorText: String, useTheme: () => ({ dark: false }) }))
    const record = name => (...args) => navigation.push([name, ...args])
    mock.module(${JSON.stringify(import.meta.resolve('expo-router'))}, () => ({
      Redirect: 'Redirect',
      router: { replace: record('replace'), push: record('push'), back: record('back'), dismissTo: record('dismissTo'), canGoBack: () => true },
      useFocusEffect: () => {},
      useLocalSearchParams: () => ({ host: 'desk' }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/h5'))}, () => ({ isH5: false }))
    const host = { id: 'desk', name: '书房电脑', url: 'http://192.168.1.5:3456', auth: 'lan' }
    const selected = [], removed = [], added = []
    mock.module(${JSON.stringify(import.meta.resolve('../../state/AppContext'))}, () => ({
      useApp: () => ({
        registry: { hosts: [host, { ...host, id: 'lab', name: '实验室' }], selectedId: 'lab' },
        select: async id => { selected.push(id) },
        remove: async id => { removed.push(id) },
        add: async next => { added.push(next.id) },
        error: '',
      }),
      useConnection: () => ({ host, client: null, error: '' }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({
      ...Object.fromEntries(['EmptyState', 'Footnote', 'Group', 'Icon', 'InlineError', 'ListRow', 'Mono', 'NavBar', 'ScreenView', 'SectionHeader', 'Separator', 'Spinner'].map(name => [name, name])),
      useColors: () => ({}),
      goBack: record('goBack'),
    }))
    function find(node, match) {
      if (!node || typeof node !== 'object') return
      if (match(node)) return node
      for (const child of [node.props?.children].flat(Infinity)) { const hit = find(child, match); if (hit) return hit }
    }
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    ${body}
    console.log(JSON.stringify({ navigation, selected, removed, added }))
  `
  try {
    const out = execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(String(out).trim().split('\n').at(-1) ?? '{}') as {
      navigation: unknown[][]
      selected: string[]
      removed: string[]
      added: string[]
    }
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
}

// expo-router 的 dismissTo：栈里有这个页面就一路退回去，没有才替换当前页（node_modules/expo-router 58 的 POP_TO）。
const backToExistingHome = [['dismissTo', '/']]

test('在「你的电脑」里选一台电脑后退回原来的首页，不再压一个新首页', () => {
  const result = run(`
    mock.module(${JSON.stringify(import.meta.resolve('../home/homeModel'))}, () => ({ hostCheckBadge() {}, hostCheckLine() {} }))
    mock.module(${JSON.stringify(import.meta.resolve('../home/parts'))}, () => ({ StatusDot: 'StatusDot', useNow() {}, useToneColor() {} }))
    mock.module(${JSON.stringify(import.meta.resolve('./computerModel'))}, () => ({ connectionAddress() {}, removeConfirmText: () => ({ title: '', message: '' }) }))
    mock.module(${JSON.stringify(import.meta.resolve('../home/useHostCheck'))}, () => ({ useHostCheck() {} }))
    const { default: HostsRoute } = require(${JSON.stringify(import.meta.resolve('../../app/hosts'))})
    const route = HostsRoute()
    const page = route.type(route.props)
    const row = find(page, node => node.type?.name === 'HostRow' && node.props.host.id === 'desk')
    row.props.onSelect()
    await tick()
  `)
  expect(result.selected).toEqual(['desk'])
  expect(result.navigation).toEqual(backToExistingHome)
})

test('在电脑设置页移除这台电脑后退回原来的首页', () => {
  const result = run(`
    // 渲染时用到的展示模型都和导航无关，统一给一个取什么都不报错的占位。
    const any = new Proxy(function () {}, { get: (_, key) => (key === Symbol.toPrimitive ? () => '' : any), apply: () => any })
    const stub = names => () => Object.fromEntries(names.map(name => [name, any]))
    mock.module(${JSON.stringify(import.meta.resolve('../modes'))}, stub(['modeName', 'effortName']))
    mock.module(${JSON.stringify(import.meta.resolve('../home/parts'))}, () => ({ StatusDot: 'StatusDot', useNow: () => 0 }))
    mock.module(${JSON.stringify(import.meta.resolve('../home/useHostCheck'))}, stub(['useHostCheck']))
    mock.module(${JSON.stringify(import.meta.resolve('../compose/glyphs'))}, () => ({ Glyph: 'Glyph' }))
    mock.module(${JSON.stringify(import.meta.resolve('../settings/AutoAnswerSheet'))}, () => ({ AutoAnswerSheet: 'AutoAnswerSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../settings/settingsModel'))}, stub(['autoAnswerValue', 'nextAutoQuestion']))
    mock.module(${JSON.stringify(import.meta.resolve('./parts'))}, () => ({ GaugeGlyph: 'GaugeGlyph', SettingRow: 'SettingRow' }))
    mock.module(${JSON.stringify(import.meta.resolve('./PermissionSheet'))}, () => ({ PermissionSheet: 'PermissionSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('./useComputerValues'))}, () => ({ useComputerValues: () => ({ values: { errors: {} }, patch() {} }) }))
    mock.module(${JSON.stringify(import.meta.resolve('./computerModel'))}, () => ({
      ...stub(['computerStatus', 'connectionAddress', 'connectionMethod', 'defaultsFootnote', 'desktopOnlyText', 'permissionAccess', 'remoteAuthLine'])(),
      removeConfirmText: () => ({ title: '移除', message: '' }),
    }))
    const { default: Computer } = require(${JSON.stringify(import.meta.resolve('../../app/computer'))})
    const route = Computer()
    const page = route.type(route.props)
    const button = find(page, node => String(node.props?.accessibilityLabel ?? '').startsWith('从这台手机移除'))
    button.props.onPress()
    alerts.at(-1).find(action => action.style === 'destructive').onPress()
    await tick()
  `)
  expect(result.removed).toEqual(['desk'])
  expect(result.navigation).toEqual(backToExistingHome)
})

test('在连接页加一台电脑、验证通过后退回原来的首页', () => {
  const result = run(`
    mock.module('expo-clipboard', () => ({ getStringAsync: async () => '' }))
    mock.module('expo-crypto', () => ({ randomUUID: () => 'new-desk' }))
    mock.module('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
    mock.module(${JSON.stringify(import.meta.resolve('../../state/api'))}, () => ({ createApiClient() {} }))
    mock.module(${JSON.stringify(import.meta.resolve('../../core/connectHost'))}, () => ({
      pairingMessage: String,
      connectHost: async input => ({ host: { id: input.id, name: input.name, url: input.value, auth: 'lan' }, credential: input.token }),
    }))
    mock.module(${JSON.stringify(import.meta.resolve('../connect/Scanner'))}, () => ({ Scanner: 'Scanner' }))
    mock.module(${JSON.stringify(import.meta.resolve('../connect/ManualSheet'))}, () => ({ ManualSheet: 'ManualSheet' }))
    mock.module(${JSON.stringify(import.meta.resolve('../connect/PairingView'))}, () => ({ PairingView: 'PairingView' }))
    const { default: ConnectRoute } = require(${JSON.stringify(import.meta.resolve('../../app/connect'))})
    const sheet = () => { cursor = 0; const route = ConnectRoute(); return find(route.type(route.props), node => node.type === 'ManualSheet').props }
    sheet().onAddressChange('http://192.168.1.5:3711')
    sheet().onTokenChange('h5_fixture_token_0123456789')
    sheet().onConnect()
    await tick()
    await tick()
  `)
  expect(result.added).toEqual(['new-desk'])
  expect(result.navigation).toEqual(backToExistingHome)
})
