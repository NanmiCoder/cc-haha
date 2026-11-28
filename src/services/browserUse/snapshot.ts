import { redactSensitiveValue, wrapUntrustedBrowserContent } from './security'
import type {
  BrowserRefEntry,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserTargetKind,
  CdpTransport,
  WrappedUntrustedContent,
} from './types'

const DEFAULT_MAX_NODES = 400
const DEFAULT_MAX_CHARS = 28_000
const DEFAULT_MAX_SCREENSHOT_BYTES = 512 * 1024
const DEFAULT_JPEG_QUALITY = 72
const JPEG_FALLBACK_QUALITIES = [48, 28, 18]

const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'treeitem',
  'gridcell',
])

const STRUCTURAL_AX_ROLES = new Set([
  'heading',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'form',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'table',
  'row',
  'columnheader',
  'rowheader',
  'img',
  'list',
  'listitem',
  'article',
  'section',
])

interface RawAxValue {
  type?: string
  value?: unknown
}

interface RawAxProperty {
  name?: string
  value?: RawAxValue
}

export interface RawAxNode {
  nodeId: string
  ignored?: boolean
  role?: RawAxValue
  name?: RawAxValue
  description?: RawAxValue
  value?: RawAxValue
  properties?: RawAxProperty[]
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
  frameId?: string
}

export interface DomScanCandidate {
  backendNodeId: number
  role: string
  name: string
  tagName: string
  inputType?: string
  isPassword?: boolean
  value?: string
  checked?: boolean
  disabled?: boolean
  hint?: string
  source: 'dom' | 'label'
}

export interface DomScanOutput {
  candidates: DomScanCandidate[]
  excludedBackendNodeIds: Set<number>
  passwordBackendNodeIds: Set<number>
  hintByBackendNodeId: Map<number, string>
}

interface StoredTabSnapshotState {
  frameId: string
  loaderId: string
  lastTreeText: string
  refsById: Map<string, BrowserRefEntry>
}

/**
 * Monotonic, never-recycled `@eN` ref registry scoped by `(tabId, frameId, loaderId)`.
 */
export class SnapshotRefStore {
  private nextCounter = 1
  private readonly tabs = new Map<string, StoredTabSnapshotState>()

  allocateRefId(): string {
    const id = `@e${this.nextCounter}`
    this.nextCounter += 1
    return id
  }

  getNextCounter(): number {
    return this.nextCounter
  }

  commitSnapshot(
    tabId: string,
    frameId: string,
    loaderId: string,
    refs: BrowserRefEntry[],
    treeText: string,
  ): { previousTreeText?: string } {
    const prev = this.tabs.get(tabId)
    const previousTreeText = prev?.lastTreeText
    const refsById = new Map<string, BrowserRefEntry>()
    for (const ref of refs) {
      refsById.set(ref.refId, ref)
    }
    this.tabs.set(tabId, {
      frameId,
      loaderId,
      lastTreeText: treeText,
      refsById,
    })
    return { previousTreeText }
  }

  getRef(
    tabId: string,
    refId: string,
    expectedFrameId?: string,
    expectedLoaderId?: string,
  ): BrowserRefEntry | undefined {
    const state = this.tabs.get(tabId)
    if (!state) {
      return undefined
    }
    const entry = state.refsById.get(refId)
    if (!entry) {
      return undefined
    }
    if (expectedFrameId && entry.frameId !== expectedFrameId) {
      return undefined
    }
    if (expectedLoaderId && entry.loaderId !== expectedLoaderId) {
      return undefined
    }
    return entry
  }

  getTabState(tabId: string): StoredTabSnapshotState | undefined {
    return this.tabs.get(tabId)
  }

  invalidateTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  clear(): void {
    this.tabs.clear()
  }
}

export function buildHumanLabel(
  role: string,
  name: string,
  hint?: string,
  tagName?: string,
): string {
  const cleanName = name.replace(/\s+/g, ' ').trim()
  if (cleanName) {
    return cleanName.length > 48 ? `${cleanName.slice(0, 45)}...` : cleanName
  }
  if (hint) {
    const iconMatch = /icon:([^;]+)/.exec(hint)
    if (iconMatch?.[1]) {
      return `${iconMatch[1].trim()} ${role}`
    }
  }
  const readableRole = role && role !== 'generic' ? role : tagName || 'element'
  return readableRole
}

/**
 * Computes a compact line-level diff between two snapshot trees.
 */
export function computeSnapshotDiff(
  previousText: string,
  currentText: string,
): { diff: string; changed: boolean } {
  if (previousText === currentText) {
    return { diff: '(no changes)', changed: false }
  }
  const prevLines = previousText.split('\n')
  const currLines = currentText.split('\n')
  const prevSet = new Map<string, number>()
  for (const line of prevLines) {
    prevSet.set(line, (prevSet.get(line) ?? 0) + 1)
  }
  const currSet = new Map<string, number>()
  for (const line of currLines) {
    currSet.set(line, (currSet.get(line) ?? 0) + 1)
  }

  const out: string[] = []
  const consumedPrev = new Map<string, number>()
  const consumedCurr = new Map<string, number>()

  for (const line of prevLines) {
    const inCurr = currSet.get(line) ?? 0
    const used = consumedCurr.get(line) ?? 0
    if (used < inCurr) {
      consumedCurr.set(line, used + 1)
    } else {
      out.push(`- ${line}`)
    }
  }

  for (const line of currLines) {
    const inPrev = prevSet.get(line) ?? 0
    const used = consumedPrev.get(line) ?? 0
    if (used < inPrev) {
      consumedPrev.set(line, used + 1)
    } else {
      out.push(`+ ${line}`)
    }
  }

  if (out.length === 0) {
    return { diff: '(reordered lines only)', changed: true }
  }
  return { diff: out.join('\n'), changed: true }
}

/**
 * Non-mutating DOM scan script run via `Runtime.evaluate` using a transient
 * CDP `objectGroup`. Returns element references inside an array so the caller
 * can resolve `backendNodeId` via `DOM.describeNode` with ZERO DOM mutation.
 */
export function buildNonMutatingDomScanExpression(maxCandidates = 250): string {
  return `(() => {
  const MAX = ${Math.max(10, Math.min(maxCandidates, 500))};
  const OVERLAY_SELECTOR = '[data-workspace-browser-zoom="true"], [data-cc-haha-browser-cursor="true"], [data-preview-agent], [data-cc-preview-agent], #__preview_agent_root, #__cc_haha_preview_agent__';

  const excludedEls = [];
  const candidates = [];
  const passwordEls = [];
  const hintedEls = [];
  const seen = new WeakSet();

  function isExcluded(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.matches && el.matches(OVERLAY_SELECTOR)) return true;
      if (el.closest && el.closest(OVERLAY_SELECTOR)) return true;
    } catch {}
    return false;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function isVisuallyHiddenInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (t !== 'radio' && t !== 'checkbox') return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    const rect = el.getBoundingClientRect();
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      rect.width <= 2 ||
      rect.height <= 2
    );
  }

  function extractLandmarkHint(el) {
    const parts = [];
    const svg = el.querySelector && el.querySelector('svg');
    if (svg) {
      const iconName =
        svg.getAttribute('data-icon') ||
        svg.getAttribute('aria-label') ||
        (svg.querySelector('title') && svg.querySelector('title').textContent) ||
        (typeof svg.className === 'object' && svg.className && svg.className.baseVal
          ? svg.className.baseVal.split(/\\s+/).find(c => /icon|lucide|fa-/i.test(c))
          : '');
      if (iconName) {
        parts.push('icon:' + String(iconName).trim().slice(0, 32));
      }
    }
    let cur = el.parentElement;
    let depth = 0;
    while (cur && depth < 8) {
      const tag = cur.tagName ? cur.tagName.toLowerCase() : '';
      const role = (cur.getAttribute && cur.getAttribute('role')) || '';
      if (
        tag === 'header' ||
        tag === 'nav' ||
        tag === 'main' ||
        tag === 'aside' ||
        tag === 'footer' ||
        tag === 'form' ||
        role === 'dialog' ||
        role === 'navigation' ||
        role === 'toolbar'
      ) {
        const label =
          (cur.getAttribute('aria-label') || '').trim().slice(0, 28) ||
          (cur.id ? '#' + cur.id.slice(0, 24) : '');
        parts.push('in:' + (role || tag) + (label ? ' ' + label : ''));
        break;
      }
      cur = cur.parentElement;
      depth++;
    }
    return parts.join('; ');
  }

  function extractTextName(el) {
    const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder'));
    if (aria && aria.trim()) return aria.trim().slice(0, 80);
    const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return txt.slice(0, 80);
  }

  function visitRoot(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      const el = node;
      if (el.matches && el.matches(OVERLAY_SELECTOR)) {
        excludedEls.push(el);
        node = walker.nextNode();
        continue;
      }
      if (isExcluded(el)) {
        node = walker.nextNode();
        continue;
      }

      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
      const isPassword = tag === 'input' && inputType === 'password';
      if (isPassword) {
        passwordEls.push(el);
      }

      const hint = extractLandmarkHint(el);
      if (hint && hintedEls.length < MAX) {
        hintedEls.push({ el, hint });
      }

      // Hidden radio/checkbox <label> promotion
      if (tag === 'label' && isVisible(el) && !seen.has(el) && candidates.length < MAX) {
        let control = null;
        const forId = el.getAttribute('for');
        if (forId && root.getElementById) {
          control = root.getElementById(forId);
        } else if (forId) {
          control = document.getElementById(forId);
        }
        if (!control) {
          control = el.querySelector('input[type="radio"], input[type="checkbox"]');
        }
        if (control && isVisuallyHiddenInput(control)) {
          seen.add(el);
          const ctlType = (control.getAttribute('type') || 'checkbox').toLowerCase();
          candidates.push({
            el,
            meta: {
              role: ctlType === 'radio' ? 'radio' : 'checkbox',
              name: extractTextName(el),
              tagName: 'label',
              inputType: ctlType,
              checked: Boolean(control.checked),
              disabled: Boolean(control.disabled),
              hint,
              source: 'label',
            },
          });
        }
      }

      // Non-mutating cursor-interactive DOM scan
      if (!seen.has(el) && isVisible(el) && candidates.length < MAX) {
        const style = window.getComputedStyle(el);
        const tabIndexAttr = el.getAttribute('tabindex');
        const hasValidTabIndex = tabIndexAttr !== null && tabIndexAttr !== '-1' && !Number.isNaN(Number(tabIndexAttr));
        const hasOnClick = el.hasAttribute('onclick') || typeof el.onclick === 'function';
        const isEditable = el.isContentEditable === true || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
        const isCursorPointer = style && style.cursor === 'pointer';

        if (isCursorPointer || hasOnClick || hasValidTabIndex || isEditable) {
          const nativeTag = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea';
          if (!nativeTag || isEditable || isPassword) {
            seen.add(el);
            const explicitRole = (el.getAttribute('role') || '').toLowerCase();
            candidates.push({
              el,
              meta: {
                role: explicitRole || (isEditable ? 'textbox' : 'button'),
                name: extractTextName(el),
                tagName: tag,
                inputType: inputType || undefined,
                isPassword,
                value: isPassword ? '[REDACTED]' : undefined,
                disabled: el.getAttribute('aria-disabled') === 'true' || Boolean(el.disabled),
                hint,
                source: 'dom',
              },
            });
          }
        }
      }

      // Traverse open shadowRoot without mutating DOM
      if (el.shadowRoot && el.shadowRoot.mode === 'open') {
        visitRoot(el.shadowRoot);
      }

      node = walker.nextNode();
    }
  }

  if (document.body || document.documentElement) {
    visitRoot(document.body || document.documentElement);
  }

  return {
    candidates,
    excludedEls,
    passwordEls,
    hintedEls,
  };
})()`
}

async function resolveObjectArrayElements(
  transport: CdpTransport,
  arrayObjectId: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<Array<{ index: number; objectId: string }>> {
  const props = await transport.send<{
    result?: Array<{
      name: string
      value?: { objectId?: string }
    }>
  }>(
    'Runtime.getProperties',
    { objectId: arrayObjectId, ownProperties: true },
    { sessionId, signal, timeoutMs: 5_000 },
  )
  const items: Array<{ index: number; objectId: string }> = []
  for (const prop of props.result ?? []) {
    const idx = Number(prop.name)
    if (Number.isInteger(idx) && idx >= 0 && prop.value?.objectId) {
      items.push({ index: idx, objectId: prop.value.objectId })
    }
  }
  items.sort((a, b) => a.index - b.index)
  return items
}

async function describeBackendNodeId(
  transport: CdpTransport,
  objectId: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const described = await transport.send<{
      node?: { backendNodeId?: number }
    }>(
      'DOM.describeNode',
      { objectId },
      { sessionId, signal, timeoutMs: 2_000 },
    )
    return typeof described.node?.backendNodeId === 'number'
      ? described.node.backendNodeId
      : null
  } catch {
    return null
  }
}

async function runNonMutatingDomScan(
  transport: CdpTransport,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<DomScanOutput> {
  const output: DomScanOutput = {
    candidates: [],
    excludedBackendNodeIds: new Set<number>(),
    passwordBackendNodeIds: new Set<number>(),
    hintByBackendNodeId: new Map<number, string>(),
  }

  const objectGroup = `cc_haha_dom_scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  try {
    const evaluated = await transport.send<{
      result?: { objectId?: string; value?: unknown }
      exceptionDetails?: unknown
    }>(
      'Runtime.evaluate',
      {
        expression: buildNonMutatingDomScanExpression(),
        objectGroup,
        returnByValue: false,
      },
      { sessionId, signal, timeoutMs: 5_000 },
    )

    const rootObjectId = evaluated.result?.objectId
    if (!rootObjectId) {
      // Allow simplified mock transports returning pre-resolved scan data by value
      if (
        evaluated.result?.value &&
        typeof evaluated.result.value === 'object'
      ) {
        const direct = evaluated.result.value as {
          candidates?: DomScanCandidate[]
          excludedBackendNodeIds?: number[]
          passwordBackendNodeIds?: number[]
          hints?: Record<string, string>
        }
        if (Array.isArray(direct.candidates)) {
          output.candidates.push(...direct.candidates)
        }
        for (const id of direct.excludedBackendNodeIds ?? []) {
          output.excludedBackendNodeIds.add(id)
        }
        for (const id of direct.passwordBackendNodeIds ?? []) {
          output.passwordBackendNodeIds.add(id)
        }
        if (direct.hints) {
          for (const [k, v] of Object.entries(direct.hints)) {
            const num = Number(k)
            if (Number.isInteger(num)) {
              output.hintByBackendNodeId.set(num, v)
            }
          }
        }
      }
      return output
    }

    const rootProps = await transport.send<{
      result?: Array<{ name: string; value?: { objectId?: string } }>
    }>(
      'Runtime.getProperties',
      { objectId: rootObjectId, ownProperties: true },
      { sessionId, signal, timeoutMs: 5_000 },
    )

    const propMap = new Map<string, string>()
    for (const prop of rootProps.result ?? []) {
      if (prop.value?.objectId) {
        propMap.set(prop.name, prop.value.objectId)
      }
    }

    // 1. Excluded overlay elements
    const excludedArrayId = propMap.get('excludedEls')
    if (excludedArrayId) {
      const elements = await resolveObjectArrayElements(
        transport,
        excludedArrayId,
        sessionId,
        signal,
      )
      for (const item of elements) {
        const backendNodeId = await describeBackendNodeId(
          transport,
          item.objectId,
          sessionId,
          signal,
        )
        if (backendNodeId !== null) {
          output.excludedBackendNodeIds.add(backendNodeId)
        }
      }
    }

    // 2. Password input elements
    const passwordArrayId = propMap.get('passwordEls')
    if (passwordArrayId) {
      const elements = await resolveObjectArrayElements(
        transport,
        passwordArrayId,
        sessionId,
        signal,
      )
      for (const item of elements) {
        const backendNodeId = await describeBackendNodeId(
          transport,
          item.objectId,
          sessionId,
          signal,
        )
        if (backendNodeId !== null) {
          output.passwordBackendNodeIds.add(backendNodeId)
        }
      }
    }

    // 3. Hinted elements
    const hintedArrayId = propMap.get('hintedEls')
    if (hintedArrayId) {
      const entries = await resolveObjectArrayElements(
        transport,
        hintedArrayId,
        sessionId,
        signal,
      )
      for (const entry of entries) {
        const entryProps = await transport.send<{
          result?: Array<{
            name: string
            value?: { objectId?: string; value?: unknown }
          }>
        }>(
          'Runtime.getProperties',
          { objectId: entry.objectId, ownProperties: true },
          { sessionId, signal, timeoutMs: 3_000 },
        )
        let elObjId: string | undefined
        let hintText: string | undefined
        for (const p of entryProps.result ?? []) {
          if (p.name === 'el') elObjId = p.value?.objectId
          if (p.name === 'hint' && typeof p.value?.value === 'string') {
            hintText = p.value.value
          }
        }
        if (elObjId && hintText) {
          const backendNodeId = await describeBackendNodeId(
            transport,
            elObjId,
            sessionId,
            signal,
          )
          if (backendNodeId !== null) {
            output.hintByBackendNodeId.set(backendNodeId, hintText)
          }
        }
      }
    }

    // 4. Interactive DOM/Label candidates
    const candidatesArrayId = propMap.get('candidates')
    if (candidatesArrayId) {
      const entries = await resolveObjectArrayElements(
        transport,
        candidatesArrayId,
        sessionId,
        signal,
      )
      for (const entry of entries) {
        const entryProps = await transport.send<{
          result?: Array<{
            name: string
            value?: { objectId?: string; value?: unknown }
          }>
        }>(
          'Runtime.getProperties',
          { objectId: entry.objectId, ownProperties: true },
          { sessionId, signal, timeoutMs: 3_000 },
        )
        let elObjId: string | undefined
        let metaObjId: string | undefined
        for (const p of entryProps.result ?? []) {
          if (p.name === 'el') elObjId = p.value?.objectId
          if (p.name === 'meta') metaObjId = p.value?.objectId
        }
        if (!elObjId || !metaObjId) continue

        const [backendNodeId, metaRes] = await Promise.all([
          describeBackendNodeId(transport, elObjId, sessionId, signal),
          transport.send<{ result?: { value?: Record<string, unknown> } }>(
            'Runtime.callFunctionOn',
            {
              objectId: metaObjId,
              functionDeclaration: 'function() { return this; }',
              returnByValue: true,
            },
            { sessionId, signal, timeoutMs: 2_000 },
          ),
        ])

        if (backendNodeId === null) continue
        const meta = metaRes.result?.value ?? {}
        output.candidates.push({
          backendNodeId,
          role: typeof meta.role === 'string' ? meta.role : 'button',
          name: typeof meta.name === 'string' ? meta.name : '',
          tagName: typeof meta.tagName === 'string' ? meta.tagName : 'div',
          inputType:
            typeof meta.inputType === 'string' ? meta.inputType : undefined,
          isPassword: meta.isPassword === true,
          value: typeof meta.value === 'string' ? meta.value : undefined,
          checked: typeof meta.checked === 'boolean' ? meta.checked : undefined,
          disabled:
            typeof meta.disabled === 'boolean' ? meta.disabled : undefined,
          hint: typeof meta.hint === 'string' && meta.hint ? meta.hint : undefined,
          source: meta.source === 'label' ? 'label' : 'dom',
        })
      }
    }
  } catch {
    // Fallback cleanly if Runtime/DOM scan is unavailable on a restricted page
  } finally {
    void transport
      .send('Runtime.releaseObjectGroup', { objectGroup }, { sessionId })
      .catch(() => {})
  }

  return output
}

function getAxProp(
  node: RawAxNode,
  name: string,
): unknown {
  for (const prop of node.properties ?? []) {
    if (prop.name === name) {
      return prop.value?.value
    }
  }
  return undefined
}

function isAxPasswordNode(
  node: RawAxNode,
  passwordBackendNodeIds: Set<number>,
): boolean {
  if (
    typeof node.backendDOMNodeId === 'number' &&
    passwordBackendNodeIds.has(node.backendDOMNodeId)
  ) {
    return true
  }
  if (getAxProp(node, 'protected') === true) {
    return true
  }
  const inputType = getAxProp(node, 'inputType')
  if (typeof inputType === 'string' && inputType.toLowerCase() === 'password') {
    return true
  }
  const role = String(node.role?.value ?? '').toLowerCase()
  const name = String(node.name?.value ?? '').toLowerCase()
  const value = String(node.value?.value ?? '')
  if (role === 'textbox' && value.length > 0 && /^[•*]+$/.test(value)) {
    return true
  }
  if (
    role === 'textbox' &&
    (getAxProp(node, 'autocomplete') === 'current-password' ||
      getAxProp(node, 'autocomplete') === 'new-password')
  ) {
    return true
  }
  // Never guess password solely from name if inputType is text, unless protected
  void name
  return false
}

export interface CompactAxTreeOptions {
  nodes: RawAxNode[]
  domScan: DomScanOutput
  frameId: string
  loaderId: string
  refStore: SnapshotRefStore
  maxNodes?: number
  includeNonInteractive?: boolean
}

export interface CompactAxTreeResult {
  refs: BrowserRefEntry[]
  treeText: string
}

export function compactAccessibilityTree(
  options: CompactAxTreeOptions,
): CompactAxTreeResult {
  const {
    nodes,
    domScan,
    frameId,
    loaderId,
    refStore,
    maxNodes = DEFAULT_MAX_NODES,
    includeNonInteractive = true,
  } = options

  const nodeById = new Map<string, RawAxNode>()
  for (const node of nodes) {
    nodeById.set(node.nodeId, node)
  }

  // Mark subtrees rooted at excluded overlay nodes (workspace zoom controls,
  // preview-agent overlays, in-page virtual cursor) so they never pollute AXTree.
  const excludedAxNodeIds = new Set<string>()
  const markExcludedSubtree = (nodeId: string) => {
    if (excludedAxNodeIds.has(nodeId)) return
    excludedAxNodeIds.add(nodeId)
    const node = nodeById.get(nodeId)
    for (const childId of node?.childIds ?? []) {
      markExcludedSubtree(childId)
    }
  }
  for (const node of nodes) {
    if (
      typeof node.backendDOMNodeId === 'number' &&
      domScan.excludedBackendNodeIds.has(node.backendDOMNodeId)
    ) {
      markExcludedSubtree(node.nodeId)
    }
  }

  const refs: BrowserRefEntry[] = []
  const seenBackendIds = new Set<number>()
  const roleNameCounts = new Map<string, number>()
  const lines: string[] = []
  let emittedCount = 0

  const nextNth = (role: string, name: string): number => {
    const key = `${role}::${name.toLowerCase()}`
    const current = roleNameCounts.get(key) ?? 0
    roleNameCounts.set(key, current + 1)
    return current
  }

  const formatEntryLine = (
    depth: number,
    refId: string | null,
    role: string,
    name: string,
    attrs: string[],
  ): string => {
    const indent = '  '.repeat(Math.min(depth, 6))
    const refPart = refId ? `${refId} ` : ''
    const namePart = name ? ` "${name.replaceAll('"', '\\"')}"` : ''
    const attrPart = attrs.length > 0 ? ` (${attrs.join(', ')})` : ''
    return `${indent}- ${refPart}[${role}]${namePart}${attrPart}`
  }

  const visit = (nodeId: string, depth: number) => {
    if (emittedCount >= maxNodes || excludedAxNodeIds.has(nodeId)) {
      return
    }
    const node = nodeById.get(nodeId)
    if (!node) {
      return
    }

    const role = String(node.role?.value ?? '').toLowerCase()
    const rawName = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim()
    const backendNodeId = node.backendDOMNodeId
    const isInteractive =
      !node.ignored &&
      INTERACTIVE_AX_ROLES.has(role) &&
      typeof backendNodeId === 'number' &&
      backendNodeId > 0

    let nextDepth = depth

    if (isInteractive && !seenBackendIds.has(backendNodeId)) {
      seenBackendIds.add(backendNodeId)
      const isPassword = isAxPasswordNode(node, domScan.passwordBackendNodeIds)
      const rawVal =
        node.value?.value !== undefined ? String(node.value.value) : undefined
      const safeValue =
        isPassword
          ? '[REDACTED]'
          : rawVal !== undefined
            ? redactSensitiveValue(rawVal, false)
            : undefined
      const hint = domScan.hintByBackendNodeId.get(backendNodeId)
      const checked = getAxProp(node, 'checked')
      const disabled = getAxProp(node, 'disabled') === true
      const expanded = getAxProp(node, 'expanded')
      const selected = getAxProp(node, 'selected')
      const nth = nextNth(role, rawName)
      const refId = refStore.allocateRefId()
      const humanLabel = buildHumanLabel(role, rawName, hint)

      const entry: BrowserRefEntry = {
        refId,
        backendNodeId,
        frameId: node.frameId ?? frameId,
        loaderId,
        role,
        name: rawName,
        humanLabel,
        nth,
        ...(hint ? { hint } : {}),
        ...(isPassword ? { isPassword: true, inputType: 'password' } : {}),
        ...(safeValue !== undefined ? { value: safeValue } : {}),
        ...(typeof checked === 'boolean' ? { checked } : {}),
        ...(disabled ? { disabled: true } : {}),
        ...(typeof expanded === 'boolean' ? { expanded } : {}),
        ...(typeof selected === 'boolean' ? { selected } : {}),
        source: 'ax',
      }
      refs.push(entry)

      const attrs: string[] = []
      if (isPassword) attrs.push('password')
      if (safeValue !== undefined && safeValue !== '') {
        attrs.push(`value="${safeValue.slice(0, 60)}"`)
      }
      if (checked === true || checked === 'true') attrs.push('checked')
      if (disabled) attrs.push('disabled')
      if (expanded === true) attrs.push('expanded')
      if (selected === true) attrs.push('selected')
      if (nth > 0) attrs.push(`nth=${nth}`)
      if (hint) attrs.push(`hint: ${hint}`)

      lines.push(formatEntryLine(depth, refId, role, rawName, attrs))
      emittedCount += 1
      nextDepth = depth + 1
    } else if (
      includeNonInteractive &&
      !node.ignored &&
      STRUCTURAL_AX_ROLES.has(role) &&
      (rawName || role === 'dialog' || role === 'main' || role === 'form')
    ) {
      const attrs: string[] = []
      const level = getAxProp(node, 'level')
      if (role === 'heading' && typeof level === 'number') {
        attrs.push(`level=${level}`)
      }
      lines.push(formatEntryLine(depth, null, role, rawName, attrs))
      emittedCount += 1
      nextDepth = depth + 1
    } else if (
      includeNonInteractive &&
      !node.ignored &&
      role === 'statictext' &&
      rawName.length >= 2 &&
      rawName.length <= 160
    ) {
      lines.push(formatEntryLine(depth, null, 'text', rawName, []))
      emittedCount += 1
    }

    for (const childId of node.childIds ?? []) {
      visit(childId, nextDepth)
    }
  }

  // Start from root node(s) (nodes without parentId, or first node)
  const roots = nodes.filter(n => !n.parentId || !nodeById.has(n.parentId))
  if (roots.length > 0) {
    for (const root of roots) {
      visit(root.nodeId, 0)
    }
  } else if (nodes.length > 0) {
    visit(nodes[0]!.nodeId, 0)
  }

  // Merge non-mutating DOM scan candidates and hidden radio/checkbox promoted labels
  for (const candidate of domScan.candidates) {
    if (emittedCount >= maxNodes) break
    if (domScan.excludedBackendNodeIds.has(candidate.backendNodeId)) continue
    if (seenBackendIds.has(candidate.backendNodeId)) continue

    seenBackendIds.add(candidate.backendNodeId)
    const isPassword =
      candidate.isPassword === true ||
      domScan.passwordBackendNodeIds.has(candidate.backendNodeId)
    const safeValue = isPassword
      ? '[REDACTED]'
      : candidate.value !== undefined
        ? redactSensitiveValue(candidate.value, false)
        : undefined
    const nth = nextNth(candidate.role, candidate.name)
    const refId = refStore.allocateRefId()
    const humanLabel = buildHumanLabel(
      candidate.role,
      candidate.name,
      candidate.hint,
      candidate.tagName,
    )

    const entry: BrowserRefEntry = {
      refId,
      backendNodeId: candidate.backendNodeId,
      frameId,
      loaderId,
      role: candidate.role,
      name: candidate.name,
      humanLabel,
      nth,
      tagName: candidate.tagName,
      ...(candidate.inputType ? { inputType: candidate.inputType } : {}),
      ...(candidate.hint ? { hint: candidate.hint } : {}),
      ...(isPassword ? { isPassword: true } : {}),
      ...(safeValue !== undefined ? { value: safeValue } : {}),
      ...(typeof candidate.checked === 'boolean'
        ? { checked: candidate.checked }
        : {}),
      ...(candidate.disabled ? { disabled: true } : {}),
      source: candidate.source,
    }
    refs.push(entry)

    const attrs: string[] = []
    if (candidate.source === 'label') attrs.push('promoted-label')
    if (candidate.source === 'dom') attrs.push('cursor-interactive')
    if (isPassword) attrs.push('password')
    if (safeValue !== undefined) attrs.push(`value="${safeValue}"`)
    if (candidate.checked) attrs.push('checked')
    if (candidate.disabled) attrs.push('disabled')
    if (nth > 0) attrs.push(`nth=${nth}`)
    if (candidate.hint) attrs.push(`hint: ${candidate.hint}`)

    lines.push(formatEntryLine(0, refId, candidate.role, candidate.name, attrs))
    emittedCount += 1
  }

  return {
    refs,
    treeText: lines.join('\n'),
  }
}

export interface FrameIdentity {
  frameId: string
  loaderId: string
  url: string
}

export async function getTopFrameIdentity(
  transport: CdpTransport,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<FrameIdentity> {
  const tree = await transport.send<{
    frameTree?: {
      frame?: {
        id?: string
        loaderId?: string
        url?: string
      }
    }
  }>('Page.getFrameTree', undefined, { sessionId, signal, timeoutMs: 5_000 })
  const frame = tree.frameTree?.frame
  return {
    frameId: frame?.id ?? 'main',
    loaderId: frame?.loaderId ?? 'initial',
    url: frame?.url ?? 'about:blank',
  }
}

export async function captureBoundedScreenshot(
  transport: CdpTransport,
  options: {
    sessionId?: string
    format?: 'jpeg' | 'png'
    quality?: number
    maxBytes?: number
    signal?: AbortSignal
  } = {},
): Promise<{ dataUrl: string; mimeType: string; bytes: number }> {
  const format = options.format ?? 'jpeg'
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES
  const initialQuality = options.quality ?? DEFAULT_JPEG_QUALITY
  const qualities =
    format === 'jpeg'
      ? [initialQuality, ...JPEG_FALLBACK_QUALITIES.filter(q => q < initialQuality)]
      : [100]

  let lastData = ''
  let lastBytes = 0
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'

  for (const quality of qualities) {
    const res = await transport.send<{ data?: string }>(
      'Page.captureScreenshot',
      {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
        fromSurface: true,
      },
      { sessionId: options.sessionId, signal: options.signal, timeoutMs: 10_000 },
    )
    const base64 = typeof res.data === 'string' ? res.data : ''
    const bytes = Math.floor((base64.length * 3) / 4)
    lastData = base64
    lastBytes = bytes
    if (bytes <= maxBytes) {
      break
    }
  }

  return {
    dataUrl: `data:${mimeType};base64,${lastData}`,
    mimeType,
    bytes: lastBytes,
  }
}

export interface CaptureSnapshotParams {
  transport: CdpTransport
  tabId: string
  target: BrowserTargetKind
  cdpSessionId?: string
  refStore: SnapshotRefStore
  options?: BrowserSnapshotOptions
  beforeScreenshot?: () => Promise<void>
  afterScreenshot?: () => Promise<void>
}

/**
 * Captures a race-checked (`Page.getFrameTree` pre/post `loaderId`), compacted,
 * CSPRNG-wrapped accessibility + non-mutating DOM snapshot with optional diff
 * and bounded screenshot.
 */
export async function capturePageSnapshot(
  params: CaptureSnapshotParams,
): Promise<BrowserSnapshotResult> {
  const {
    transport,
    tabId,
    target,
    cdpSessionId,
    refStore,
    options = {},
    beforeScreenshot,
    afterScreenshot,
  } = params

  const maxAttempts = 2
  let frameIdentity: FrameIdentity | null = null
  let compacted: CompactAxTreeResult | null = null
  let pageTitle = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const preFrame = await getTopFrameIdentity(
      transport,
      cdpSessionId,
      options.signal,
    )

    const [axRes, domScan, titleRes] = await Promise.all([
      transport.send<{ nodes?: RawAxNode[] }>(
        'Accessibility.getFullAXTree',
        undefined,
        { sessionId: cdpSessionId, signal: options.signal, timeoutMs: 10_000 },
      ),
      runNonMutatingDomScan(transport, cdpSessionId, options.signal),
      transport
        .send<{ result?: { value?: string } }>(
          'Runtime.evaluate',
          { expression: 'document.title || ""', returnByValue: true },
          { sessionId: cdpSessionId, signal: options.signal, timeoutMs: 3_000 },
        )
        .catch(() => ({ result: { value: '' } })),
    ])

    const postFrame = await getTopFrameIdentity(
      transport,
      cdpSessionId,
      options.signal,
    )

    if (
      preFrame.frameId !== postFrame.frameId ||
      preFrame.loaderId !== postFrame.loaderId
    ) {
      if (attempt < maxAttempts) {
        continue
      }
      throw new Error(
        `Snapshot aborted due to concurrent navigation (loaderId changed from ${preFrame.loaderId} to ${postFrame.loaderId})`,
      )
    }

    frameIdentity = postFrame
    pageTitle =
      typeof titleRes.result?.value === 'string' ? titleRes.result.value : ''
    compacted = compactAccessibilityTree({
      nodes: axRes.nodes ?? [],
      domScan,
      frameId: postFrame.frameId,
      loaderId: postFrame.loaderId,
      refStore,
      maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
      includeNonInteractive: options.includeNonInteractive ?? true,
    })
    break
  }

  if (!frameIdentity || !compacted) {
    throw new Error('Failed to capture page snapshot')
  }

  const { previousTreeText } = refStore.commitSnapshot(
    tabId,
    frameIdentity.frameId,
    frameIdentity.loaderId,
    compacted.refs,
    compacted.treeText,
  )

  let diff: string | undefined
  let diffChanged: boolean | undefined
  let payloadText = compacted.treeText

  if (options.diff && previousTreeText !== undefined) {
    const computed = computeSnapshotDiff(previousTreeText, compacted.treeText)
    diff = computed.diff
    diffChanged = computed.changed
    payloadText = computed.diff
  }

  const wrappedTree: WrappedUntrustedContent = wrapUntrustedBrowserContent(
    payloadText,
    {
      source: 'browser_snapshot',
      kind: options.diff && diff !== undefined ? 'snapshot_diff' : 'snapshot',
      tabId,
      url: frameIdentity.url,
      title: pageTitle,
      maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
    },
  )

  let screenshotDataUrl: string | undefined
  let screenshotMimeType: string | undefined
  let screenshotBytes: number | undefined

  if (options.screenshot) {
    if (beforeScreenshot) {
      await beforeScreenshot()
    }
    try {
      const shot = await captureBoundedScreenshot(transport, {
        sessionId: cdpSessionId,
        format: options.screenshotFormat ?? 'jpeg',
        quality: options.screenshotQuality ?? DEFAULT_JPEG_QUALITY,
        maxBytes: options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES,
        signal: options.signal,
      })
      screenshotDataUrl = shot.dataUrl
      screenshotMimeType = shot.mimeType
      screenshotBytes = shot.bytes
    } finally {
      if (afterScreenshot) {
        await afterScreenshot()
      }
    }
  }

  return {
    tabId,
    target,
    url: frameIdentity.url,
    title: pageTitle,
    frameId: frameIdentity.frameId,
    loaderId: frameIdentity.loaderId,
    refCount: compacted.refs.length,
    refs: compacted.refs,
    treeText: compacted.treeText,
    wrappedTree,
    ...(diff !== undefined ? { diff, diffChanged } : {}),
    ...(screenshotDataUrl
      ? { screenshotDataUrl, screenshotMimeType, screenshotBytes }
      : {}),
  }
}
