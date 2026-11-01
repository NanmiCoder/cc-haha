import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'

test('photo QR selection shares the scanner result boundary and releases the camera safely', () => {
  // Execute the real component with deterministic native adapters. This verifies
  // JS lifecycle and callback wiring, not Android camera frames or ML Kit decoding.
  const dir = mkdtempSync(join(tmpdir(), 'mobile-scanner-'))
  const script = `
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
let cursor = 0
const slots = []
let effects = []
let dirty = false
const appListeners = new Set()
const equal = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]))
const React = await import(${JSON.stringify(import.meta.resolve('react'))})
mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
  ...React,
  useEffectEvent: callback => callback,
  useRef(value) { const id = cursor++; return slots[id] ??= { current: value } },
  useState(initial) {
    const id = cursor++
    if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial
    return [slots[id], (next) => {
      const value = typeof next === 'function' ? next(slots[id]) : next
      if (!Object.is(value, slots[id])) { slots[id] = value; dirty = true }
    }]
  },
  useEffect(effect, deps) {
    const id = cursor++
    if (!slots[id] || !equal(slots[id].deps, deps)) {
      const previous = slots[id]
      slots[id] = { deps }
      effects.push(() => { previous?.cleanup?.(); slots[id].cleanup = effect() })
    }
  },
}))
mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
  Linking: { openSettings: async () => {} }, Pressable: 'Pressable', View: 'View', ScrollView: 'ScrollView',
  AppState: { addEventListener: (_event, callback) => { appListeners.add(callback); return { remove: () => appListeners.delete(callback) } } },
  StyleSheet: { absoluteFill: {} }, Platform: { OS: 'android', select: values => values.android ?? values.default },
}))
mock.module(${JSON.stringify(import.meta.resolve('react-native-safe-area-context'))}, () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) }))
let granted = true
let pickCalls = 0, decodeCalls = 0, finishPick, failPick, finishDecode, failDecode
let pendingResult = null
let pendingFailure = false
mock.module(${JSON.stringify(import.meta.resolve('expo-image-picker'))}, () => ({
  async getPendingResultAsync() {
    if (pendingFailure) { pendingFailure = false; throw new Error('private image URI unreadable') }
    const result = pendingResult; pendingResult = null; return result
  },
  launchImageLibraryAsync(options) {
    pickCalls++
    assert.deepEqual(options.mediaTypes, ['images'])
    assert.equal(options.allowsMultipleSelection, false)
    assert.equal(options.quality, 1)
    return new Promise((resolve, reject) => { finishPick = resolve; failPick = reject })
  },
}))
mock.module(${JSON.stringify(import.meta.resolve('expo-camera'))}, () => ({
  CameraView: 'CameraView', useCameraPermissions: () => [{ granted, canAskAgain: true }, async () => {}],
  scanFromURLAsync(uri, types) {
    decodeCalls++
    assert.equal(uri, 'file:///fixture-only.png')
    assert.deepEqual(types, ['qr'])
    return new Promise((resolve, reject) => { finishDecode = resolve; failDecode = reject })
  },
}))
mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({ BrandMark: 'BrandMark', Icon: 'Icon', useColors: () => ({}) }))
mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
mock.module(${JSON.stringify(import.meta.resolve('../theme'))}, () => ({ errorText: e => e.message }))
mock.module(${JSON.stringify(import.meta.resolve('./motion'))}, () => ({ ScanLine: 'ScanLine' }))
mock.module(${JSON.stringify(import.meta.resolve('../webChrome'))}, () => ({ simulatedPhoneChrome: false }))
const { Scanner } = await import(${JSON.stringify(import.meta.resolve('./Scanner'))})
const { receivedConnection } = await import(${JSON.stringify(import.meta.resolve('./connectForm'))})
const received = []
let notice = '', active = true, tree
function render() {
  do {
    dirty = false; cursor = 0
    tree = Scanner({ active, firstRun: false, notice,
      onNotice: value => { notice = value }, onClose() {}, onPaste() {}, onManual() {},
      onScanned: value => { received.push(receivedConnection(value)) },
    })
    const pending = effects; effects = []; pending.forEach(effect => effect())
  } while (dirty)
}
function find(predicate, node = tree) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) { const result = find(predicate, child); if (result) return result } }
  else { if (predicate(node)) return node; if (node.props?.children !== undefined) return find(predicate, node.props.children) }
}
const photo = () => {
  const button = find(n => n.props?.title === '从相册选择二维码')
  assert.ok(button, 'the scanner must offer photo QR selection')
  return button
}
const camera = () => find(n => n.type === 'CameraView')
const tick = async () => { for (let i=0; i<8; i++) await Promise.resolve(); render() }
const picked = { canceled: false, assets: [{ uri: 'file:///fixture-only.png' }] }
const lan = 'http://127.0.0.1:3457/?h5Token=fixture-only-1753'
const remote = 'https://fixture.example/remote#pair=fixture-only-1753'

render()
assert.ok(camera(), 'camera scanning remains available')
const oldCamera = camera()
const start = photo().props.onPress
start(); start(); render()
assert.equal(pickCalls, 1, 'double tap cannot launch a second picker')
assert.equal(camera(), undefined, 'release the camera while the photo picker is open')
oldCamera.props.onBarcodeScanned({ data: remote })
assert.equal(received.length, 0, 'a late camera event cannot race the photo picker')
finishPick(picked); await tick()
assert.equal(decodeCalls, 1)
assert.equal(camera(), undefined, 'keep camera paused through decoding')
finishDecode([{ type: 'qr', data: lan }]); await tick()
assert.deepEqual(received, [receivedConnection(lan)])

photo().props.onPress(); finishPick({ canceled: true, assets: null }); await tick()
assert.equal(decodeCalls, 1, 'cancel does not decode or connect')
assert.ok(camera(), 'cancel restores camera scanning')
camera().props.onBarcodeScanned({ data: lan })
camera().props.onBarcodeScanned({ data: lan })
assert.equal(received.length, 2, 'camera scanning still delivers once per QR after cancel')

granted = false; render()
photo().props.onPress(); finishPick(picked); await tick()
finishDecode([{ type: 'qr', data: remote }]); await tick()
assert.deepEqual(received[2], receivedConnection(remote), 'photo scanning works without camera permission')
assert.equal(camera(), undefined)

photo().props.onPress(); finishPick(picked); await tick()
finishDecode([]); await tick()
assert.match(notice, /没有识别到二维码/)
assert.equal(received.length, 3)
assert.ok(find(n => n.type === 'ScrollView'), 'short screens can scroll to photo actions and feedback')
const feedback = find(n => n.props?.accessibilityRole === 'alert')
assert.ok(feedback)
assert.notEqual(feedback.props.style?.position, 'absolute', 'feedback must reserve its layout space')

photo().props.onPress(); finishPick(picked); await tick()
finishDecode([{ type: 'qr', data: lan }, { type: 'qr', data: remote }]); await tick()
assert.match(notice, /多个二维码/)
assert.equal(received.length, 3, 'ambiguous photo must not pick a computer automatically')

photo().props.onPress(); failPick(new Error('picker unavailable')); await tick()
assert.match(notice, /无法识别这张图片/)

photo().props.onPress(); finishPick(picked); await tick()
failDecode(new Error('native failure with private data')); await tick()
assert.match(notice, /无法识别这张图片/)
assert.ok(!notice.includes('private data'), 'native errors must not expose image details')

photo().props.onPress(); finishPick(picked); await tick()
active = false; render()
finishDecode([{ type: 'qr', data: lan }]); await tick()
assert.equal(received.length, 3, 'leaving the scanner ignores the pending decoder result')
active = true; granted = true; render()
assert.ok(camera())
photo().props.onPress()
pendingFailure = true
for (const callback of appListeners) callback('active')
await tick()
assert.match(notice, /无法识别这张图片/)
assert.ok(!notice.includes('private image URI'))
assert.ok(camera(), 'recovery read failure releases the pending photo operation')
photo().props.onPress()
const abandonedPick = finishPick
pendingResult = picked
for (const callback of appListeners) callback('active')
await tick()
finishDecode([{ type: 'qr', data: lan }]); await tick()
assert.equal(received.length, 4, 'Android Activity recreation delivers the pending picker result')
abandonedPick(picked); await tick()
assert.equal(received.length, 4, 'the old picker promise cannot deliver the recovered result twice')
const callsBeforeResume = pickCalls
photo().props.onPress()
assert.equal(pickCalls, callsBeforeResume + 1, 'returning to the route can open the picker again')
finishPick(picked); await tick()
for (const slot of slots) slot?.cleanup?.()
finishDecode([{ type: 'qr', data: lan }]); await tick()
assert.equal(received.length, 4, 'unmounted scanner must not receive late results')
`
  try {
    const file = join(dir, 'scanner.ts')
    writeFileSync(file, script)
    execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
