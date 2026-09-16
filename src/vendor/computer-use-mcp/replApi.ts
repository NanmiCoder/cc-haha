import type { NativeErrorMetadata } from './nativeError.js'

/**
 * Native-app facade for the isolated Computer Use JavaScript worker.
 *
 * The official @oai/cua native facade uses get_app_state for all three
 * observations. Output selection and emit:false live here, not in the native
 * capture implementation. Every invocation still crosses the host's existing
 * semantic tool policy and process-identity validation.
 */
export interface ReplImage {
  data: string
  mimeType: string
}

export interface ReplToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
  /** The approved app selector, when supplied by the host broker. */
  app?: string
  /** Structured, trusted app inventory; legacy hosts may supply only text. */
  apps?: Array<{ id: string; displayName?: string; isRunning?: boolean; lastUsedDate?: string; useCount?: number }>
  nativeError?: NativeErrorMetadata
}

export interface ReplApiBridge {
  invoke(method: string, args: Record<string, unknown>): Promise<ReplToolResult>
  emit(type: 'text', value: string): void | Promise<void>
  emit(type: 'image', value: ReplImage): void | Promise<void>
}

export interface ReplObservationOptions {
  emit?: boolean
}

export interface ReplStateOptions extends ReplObservationOptions {
  disableDiffing?: boolean
}

export type ReplPoint = [number, number]
export type ReplElement = number | string
export type ReplClickTarget = ReplElement | ReplPoint

export interface ReplClickOptions {
  mouseButton?: 'left' | 'right' | 'middle' | 'l' | 'r' | 'm' | 0 | 1 | 2
  clickCount?: number
}

export interface ReplSelectTextOptions {
  prefix?: string
  suffix?: string
  selectionType?: 'text' | 'cursor_before' | 'cursor_after'
}

/** Keep this function self-contained: its source executes in a separate realm. */
export function createReplApi(bridge: ReplApiBridge) {
  type Indices = { generation?: string; handles: Map<number, string> }
  const indicesByApp = new Map<string, Indices>()
  const appAliases = new Map<string, string>()
  const handlePattern = /^g(0|[1-9]\d*):(0|[1-9]\d*)$/u
  let hasEmittedGuidance = false
  const appGuidance = `Native App API
Bind with await cua.getApp("App name, bundle ID, or path"). Keep the returned app between cells.
Observe: app.getAXState({disableDiffing?,emit?}), app.getScreenshot({emit?}), app.getAXStateAndScreenshot({disableDiffing?,emit?}). emit:false returns data without displaying it.
Act: app.click([x,y] or element,{mouseButton?,clickCount?}), app.drag([x,y],[x,y]), app.pressKey(key), app.scroll([x,y] or element,direction,pages?), app.paste(text,{format?}), app.typeText(text), app.selectText(element,text,{prefix?,suffix?,selectionType?}), app.setValue(element,value), app.performSecondaryAction(element,action).
The raw macOS window API is also available as cua.computer (target:"mac"): list_apps(), get_app_state({app,disableDiff?}), and the corresponding snake_case action methods with an explicit app. Raw methods return data without displaying it.
Use observed gN:id handles. Integer indices require a current AX observation; after image-only capture use getAXState({disableDiffing:true}) before using integers. Coordinates refer to the returned screenshot.
Timers: setTimeout/clearTimeout and setInterval/clearInterval use numeric handles and are cleared when the cell ends. If a delay is required, await new Promise(resolve => setTimeout(resolve, milliseconds)); observations normally need no added sleep. Do not schedule actions after the cell returns.
Await actions in loops, then observe at the next decision point. nodeRepl.write(value) emits text; nodeRepl.emitImage(bytes) emits an image. Browser/DOM, imports, Node, filesystem, and networking APIs are unavailable.`

  function textOf(result: ReplToolResult): string {
    return result.content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
  }

  async function invoke(method: string, args: Record<string, unknown>) {
    const result = await bridge.invoke(method, args)
    if (result.isError) {
      const metadata = result.nativeError
      const message = metadata?.message ?? (textOf(result) || `Computer Use ${method} failed`)
      const error = metadata?.name === 'TypeError' ? new TypeError(message) : new Error(message)
      if (metadata?.name === 'SkyComputerUseError') {
        error.name = metadata.name
        if (Number.isInteger(metadata.code)) Reflect.set(error, 'code', metadata.code)
        if (typeof metadata.errorName === 'string') Reflect.set(error, 'errorName', metadata.errorName)
        if (metadata.request === null) Reflect.set(error, 'request', null)
        if (metadata.requestType === 'jsonRPC') Reflect.set(error, 'requestType', metadata.requestType)
      }
      if (typeof metadata?.nativeCode === 'string') Reflect.set(error, 'nativeCode', metadata.nativeCode)
      throw error
    }
    return result
  }

  function imageOf(result: ReplToolResult): ReplImage | undefined {
    const block = result.content.find(item => item.type === 'image')
    return block && typeof block.data === 'string' && typeof block.mimeType === 'string'
      ? { data: block.data, mimeType: block.mimeType }
      : undefined
  }

  function decodeImage(image: ReplImage): Uint8Array {
    const base64 = image.data
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
      throw new Error('The screenshot contains invalid base64 data')
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const bytes = new Uint8Array(base64.length / 4 * 3 - padding)
    let offset = 0
    for (let i = 0; i < base64.length; i += 4) {
      const n = (alphabet.indexOf(base64[i]!) << 18)
        | (alphabet.indexOf(base64[i + 1]!) << 12)
        | (Math.max(0, alphabet.indexOf(base64[i + 2]!)) << 6)
        | Math.max(0, alphabet.indexOf(base64[i + 3]!))
      if (offset < bytes.length) bytes[offset++] = (n >> 16) & 255
      if (offset < bytes.length) bytes[offset++] = (n >> 8) & 255
      if (offset < bytes.length) bytes[offset++] = n & 255
    }
    return bytes
  }

  function clearIndices(indices: Indices) {
    indices.generation = undefined
    indices.handles.clear()
  }

  function rememberState(indices: Indices, text: string) {
    // Read only the engine's AX envelope, never app-specific instructions that
    // happen to quote something resembling a handle.
    const start = text.indexOf('<app_state>\n')
    const end = text.lastIndexOf('\n</app_state>')
    const state = start >= 0 && end > start ? text.slice(start + 12, end) : text
    const lines = state.split('\n')
    const isDiff = lines.some(line => line.startsWith('The following is a diff from the previous accessibility tree ')
      || line.startsWith('There has been no change in the accessibility tree '))
    if (!isDiff) clearIndices(indices)

    for (const line of lines) {
      // A tree row starts with indentation and optionally the native diff marker.
      const match = /^[+~]?[\t ]*(g(0|[1-9]\d*):(0|[1-9]\d*))(?=\s|$)/u.exec(line)
      if (!match) continue
      const index = Number(match[3])
      if (!Number.isSafeInteger(index)) continue
      if (indices.generation !== match[2]) {
        clearIndices(indices)
        indices.generation = match[2]
      }
      indices.handles.set(index, match[1]!)
    }

    // Iterate observed IDs rather than expanding arbitrary sparse ranges.
    for (const line of lines) {
      if (!line.startsWith('Removed element IDs: ')) continue
      for (const range of line.slice(21).split(', ')) {
        const match = /^(\d+)(?:-(\d+))?$/u.exec(range)
        if (!match) continue
        const low = Number(match[1])
        const high = Number(match[2] ?? match[1])
        for (const id of indices.handles.keys()) {
          if (id >= low && id <= high) indices.handles.delete(id)
        }
      }
    }
  }

  function element(indices: Indices, target: ReplElement): string {
    if (typeof target === 'string' && handlePattern.test(target)) return target
    if (typeof target === 'number' && Number.isSafeInteger(target) && target >= 0) {
      const handle = indices.handles.get(target)
      if (handle) return handle
      throw new Error(`Element ${target} has no current observed handle. Call getAXState({disableDiffing:true}) before using an integer index.`)
    }
    throw new Error('Expected an observed integer element index or an opaque gN:id handle')
  }

  function point(value: ReplPoint, name = 'coordinate'): ReplPoint {
    if (!Array.isArray(value) || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
      throw new TypeError(`${name} must include finite x and y coordinates`)
    }
    // The official facade selects the first two tuple entries before passing
    // them to the macOS client; extra array properties are not native inputs.
    return [value[0], value[1]]
  }

  function targetArgs(indices: Indices, target: ReplClickTarget) {
    if (Array.isArray(target)) {
      const [x, y] = point(target)
      return { x, y }
    }
    return { element_index: element(indices, target) }
  }

  function mouseButton(value: ReplClickOptions['mouseButton']) {
    if (value === undefined) return undefined
    // @oai/sky uses 0/1/2. The older semantic tool uses 1/2/3: normalize
    // to names at this boundary so right clicks cannot become left clicks.
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value
    if (normalized === 0 || normalized === 'left' || normalized === 'l') return 'left'
    if (normalized === 1 || normalized === 'right' || normalized === 'r') return 'right'
    if (normalized === 2 || normalized === 'middle' || normalized === 'm') return 'middle'
    throw new TypeError(typeof value === 'number'
      ? 'mouseButton number must be 0, 1, or 2'
      : 'mouseButton must be left, right, middle, l, r, m, 0, 1, or 2')
  }

  function scrollDirection(value: string) {
    const direction = value.trim().toLowerCase()
    if (direction === 'u' || direction === 'up') return 'up'
    if (direction === 'd' || direction === 'down') return 'down'
    if (direction === 'l' || direction === 'left') return 'left'
    if (direction === 'r' || direction === 'right') return 'right'
    throw new TypeError('direction must be up, down, left, or right')
  }

  function validatePages(pages?: number) {
    if (pages !== undefined && (!Number.isFinite(pages) || pages <= 0)) {
      throw new TypeError('pages must be a finite number > 0')
    }
  }

  function indicesFor(selector: string) {
    const app = appAliases.get(selector) ?? selector
    let indices = indicesByApp.get(app)
    if (!indices) {
      indices = { handles: new Map() }
      indicesByApp.set(app, indices)
    }
    return indices
  }

  async function emitText(text: string, options?: ReplObservationOptions) {
    if (options?.emit !== false) await bridge.emit('text', text)
  }

  async function emitImage(image: ReplImage, options?: ReplObservationOptions) {
    if (options?.emit !== false) await bridge.emit('image', image)
  }

  async function emitSelectionText(text: string, options?: ReplObservationOptions) {
    if (options?.emit === false) return
    const prefix = hasEmittedGuidance ? '' : `${appGuidance}\n\n`
    hasEmittedGuidance = true
    await emitText(prefix + text)
  }

  async function listApps(options?: ReplObservationOptions) {
    const result = await invoke('list_apps', {})
    const text = textOf(result)
    // The existing engine's formatter emits exactly "displayName — bundleId".
    // No extra application metadata is inferred from this text interface.
    const apps = result.apps ?? text.split('\n').flatMap(line => {
      const separator = line.lastIndexOf(' — ')
      if (separator < 0) return []
      const id = line.slice(separator + 3)
      if (!id) return []
      return [{ id, displayName: line.slice(0, separator), isRunning: true }]
    })
    await emitText(JSON.stringify(apps), options)
    return apps
  }

  async function getState(options?: ReplObservationOptions) {
    const state = { apps: await listApps({ emit: false }), browsers: [] }
    await emitSelectionText(JSON.stringify(state), options)
    return state
  }

  async function getApp(selector: string) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new Error('getApp requires an explicit app name, bundle ID, or path')
    }
    const first = await invoke('get_app_state', { app: selector, disableDiff: true })
    // Official getApp binds the policy-approved app path returned by its first
    // observation, rather than caching a PID or trusting a guest host object.
    const app = typeof first.app === 'string' && first.app ? first.app : selector
    appAliases.set(selector, app)
    const observed = indicesFor(app)
    const firstText = textOf(first)
    rememberState(observed, firstText)
    await emitSelectionText(firstText)

    async function observe(options?: ReplStateOptions) {
      try {
        return await invoke('get_app_state', {
          app,
          ...(options?.disableDiffing === undefined ? {} : { disableDiff: options.disableDiffing }),
        })
      } catch (error) {
        clearIndices(observed)
        throw error
      }
    }

    async function action(method: string, args: Record<string, unknown>) {
      await invoke(method, { app, ...args })
    }

    return {
      async getAXState(options?: ReplStateOptions) {
        const text = textOf(await observe(options))
        rememberState(observed, text)
        await emitText(text, options)
        return text
      },
      async getScreenshot(options?: ReplObservationOptions) {
        // A hidden AX refresh may change generations. Do not create numeric
        // aliases for elements the caller did not receive in an AX observation.
        clearIndices(observed)
        const image = imageOf(await observe())
        if (!image) throw new Error(`Screenshot unavailable for ${app}.`)
        const bytes = decodeImage(image)
        await emitImage(image, options)
        return bytes
      },
      async getAXStateAndScreenshot(options?: ReplStateOptions) {
        const result = await observe(options)
        const state = textOf(result)
        rememberState(observed, state)
        await emitText(state, options)
        const image = imageOf(result)
        if (!image) return { state }
        const screenshot = decodeImage(image)
        await emitImage(image, options)
        return { state, screenshot }
      },
      async click(target: ReplClickTarget, options?: ReplClickOptions) {
        const button = mouseButton(options?.mouseButton)
        await action('click', {
          ...targetArgs(observed, target),
          ...(button === undefined ? {} : { mouse_button: button }),
          ...(options?.clickCount === undefined ? {} : { click_count: options.clickCount }),
        })
      },
      async drag(from: ReplPoint, to: ReplPoint) {
        const [from_x, from_y] = point(from, 'from')
        const [to_x, to_y] = point(to, 'to')
        await action('drag', { from_x, from_y, to_x, to_y })
      },
      async pressKey(key: string) {
        if (key.trim() === '') throw new TypeError('key is required')
        await action('press_key', { key })
      },
      async scroll(target: ReplClickTarget, direction: string, pages?: number) {
        validatePages(pages)
        await action('scroll', {
          ...targetArgs(observed, target), direction: scrollDirection(direction),
          ...(pages === undefined ? {} : { pages }),
        })
      },
      async paste(text: string, options?: { format?: 'text' | 'md' | 'html' }) {
        await action('paste', { text, format: options?.format ?? 'text' })
      },
      async typeText(text: string) {
        await action('type_text', { text })
      },
      async selectText(index: ReplElement, text: string, options?: ReplSelectTextOptions) {
        await action('select_text', {
          element_index: element(observed, index), text,
          ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
          ...(options?.suffix === undefined ? {} : { suffix: options.suffix }),
          ...(options?.selectionType === undefined ? {} : { selection_type: options.selectionType }),
        })
      },
      async setValue(index: ReplElement, value: string) {
        await action('set_value', { element_index: element(observed, index), value })
      },
      async performSecondaryAction(index: ReplElement, actionName: string) {
        await action('perform_secondary_action', { element_index: element(observed, index), action: actionName })
      },
    }
  }

  type NativeTarget = { app: string }
  type NativePointTarget = NativeTarget & { element_index?: ReplElement; x?: number; y?: number }
  async function nativeAction(method: string, input: NativeTarget & Record<string, unknown>) {
    if (typeof input.app !== 'string' || input.app.trim() === '') throw new TypeError('app is required')
    const args = { ...input }
    if (args.element_index !== undefined) args.element_index = element(indicesFor(input.app), args.element_index as ReplElement)
    await invoke(method, args)
  }
  function nativePoint(input: NativePointTarget) {
    return input.element_index !== undefined
      ? { element_index: input.element_index }
      : { x: point([input.x!, input.y!])[0], y: input.y }
  }
  // The macOS sky client exposes this window API in addition to bound Apps.
  // It still uses the same guarded host operations; it cannot access a socket,
  // native object, audio capability, or another provider directly.
  const computer = {
    target: 'mac' as const,
    list_apps: () => listApps({ emit: false }),
    async get_app_state(input: NativeTarget & { disableDiff?: boolean }) {
      if (typeof input.app !== 'string' || input.app.trim() === '') throw new TypeError('app is required')
      const result = await invoke('get_app_state', {
        app: input.app,
        ...(input.disableDiff === undefined ? {} : { disableDiff: input.disableDiff }),
      }).catch(error => {
        clearIndices(indicesFor(input.app))
        throw error
      })
      const app = typeof result.app === 'string' && result.app ? result.app : input.app
      appAliases.set(input.app, app)
      const text = textOf(result)
      rememberState(indicesFor(app), text)
      const image = imageOf(result)
      return { app, text, screenshot: image ? { url: `data:${image.mimeType};base64,${image.data}` } : null }
    },
    click: async (input: NativePointTarget & { mouse_button?: ReplClickOptions['mouseButton']; click_count?: number }) =>
      nativeAction('click', { app: input.app, ...nativePoint(input),
        ...(input.mouse_button === undefined ? {} : { mouse_button: mouseButton(input.mouse_button) }),
        ...(input.click_count === undefined ? {} : { click_count: input.click_count }) }),
    async drag(input: NativeTarget & { from_x: number; from_y: number; to_x: number; to_y: number }) {
      point([input.from_x, input.from_y], 'from')
      point([input.to_x, input.to_y], 'to')
      return nativeAction('drag', { app: input.app, from_x: input.from_x, from_y: input.from_y, to_x: input.to_x, to_y: input.to_y })
    },
    paste: async (input: NativeTarget & { text: string; format: 'text' | 'md' | 'html' }) =>
      nativeAction('paste', { app: input.app, text: input.text, format: input.format }),
    perform_secondary_action: async (input: NativeTarget & { element_index: ReplElement; action: string }) =>
      nativeAction('perform_secondary_action', { app: input.app, element_index: input.element_index, action: input.action }),
    async press_key(input: NativeTarget & { key: string }) {
      if (input.key.trim() === '') throw new TypeError('key is required')
      await nativeAction('press_key', { app: input.app, key: input.key })
    },
    async scroll(input: NativePointTarget & { direction: string; pages?: number }) {
      validatePages(input.pages)
      await nativeAction('scroll', { app: input.app, ...nativePoint(input), direction: scrollDirection(input.direction),
        ...(input.pages === undefined ? {} : { pages: input.pages }) })
    },
    select_text: async (input: NativeTarget & { element_index: ReplElement; text: string; prefix?: string; suffix?: string; selection_type?: ReplSelectTextOptions['selectionType'] }) =>
      nativeAction('select_text', { app: input.app, element_index: input.element_index, text: input.text,
        ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
        ...(input.suffix === undefined ? {} : { suffix: input.suffix }),
        ...(input.selection_type === undefined ? {} : { selection_type: input.selection_type }) }),
    set_value: async (input: NativeTarget & { element_index: ReplElement; value: string }) =>
      nativeAction('set_value', { app: input.app, element_index: input.element_index, value: input.value }),
    type_text: async (input: NativeTarget & { text: string }) => nativeAction('type_text', { app: input.app, text: input.text }),
  }

  return { getApp, listApps, getState, computer }
}

/** Only guest-created data crosses this interface; it never reads a file/URL. */
function createReplOutput(emit: (content: Record<string, unknown>) => void) {
  return {
    async write(value: unknown) {
      emit({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) ?? String(value) })
    },
    async emitImage(value: Uint8Array | { bytes: Uint8Array; mimeType?: string } | ReplImage) {
      if (value && typeof value === 'object' && 'data' in value && typeof value.data === 'string') {
        emit({ type: 'image', data: value.data, mimeType: value.mimeType })
        return
      }
      const bytes = value instanceof Uint8Array ? value
        : value && typeof value === 'object' && 'bytes' in value ? value.bytes : undefined
      if (!(bytes instanceof Uint8Array)) throw new Error('emitImage requires Uint8Array bytes or {bytes, mimeType}')
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      const parts: string[] = []
      for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]!
        const b = bytes[i + 1] ?? 0
        const c = bytes[i + 2] ?? 0
        parts.push(alphabet[a >> 2]! + alphabet[((a & 3) << 4) | (b >> 4)]!
          + (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=')
          + (i + 2 < bytes.length ? alphabet[c & 63] : '='))
      }
      emit({
        type: 'image', data: parts.join(''),
        // A screenshot returned as bytes has no MIME property. macOS captures
        // are JPEG; keep the encoded image type when displaying those bytes.
        mimeType: 'mimeType' in value && value.mimeType ? value.mimeType
          : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg' : 'image/png',
      })
    },
  }
}

export const REPL_API_SOURCE = `(${createReplApi.toString()})`

/** The worker supplies these two realm-local, JSON-only bridge functions. */
export const REPL_BOOTSTRAP_SOURCE = `
globalThis.cua = ${REPL_API_SOURCE}({
  invoke: __cuInvoke,
  emit(type, value) {
    __cuEmit(type === 'text' ? { type: 'text', text: value } : { type: 'image', ...value })
  }
});
globalThis.nodeRepl = (${createReplOutput.toString()})(__cuEmit);
`
