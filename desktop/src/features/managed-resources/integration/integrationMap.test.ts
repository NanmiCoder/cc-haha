/**
 * Structural metadata test for desktop/src/features/managed-resources/integration-map.md.
 *
 * The map is upgrade inventory: it pins U01-U17 host seams and the 10 no-feature
 * regression contracts. This test only verifies the inventory structure; it does
 * NOT claim any host seam is wired, any contract has passed, or any feature
 * behaviour is in place.
 *
 * The parser, the validator, and the mutation cases are factored so a single
 * text string can be re-validated — that is how the negative cases work:
 *   1. replace a contract identity
 *   2. replace an anchor token
 *   3. delete one `planned:` prefix
 *   4. replace a planned path with `../outside.ts`
 * Each mutation must cause the full validator to throw.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(HERE, '..', '..', '..', '..')
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..')
const MAP_PATH = path.join(
  DESKTOP_DIR,
  'src',
  'features',
  'managed-resources',
  'integration-map.md',
)
const EXPECTED_BASE_HEAD = '6561a36238e2352f389f545f87b155bf39371447'
const EXPECTED_SCOPE = 'Windows 10/11 desktop only; macOS / Swift / Linux desktop builds out of scope'

// Eight exact table headers for the U-table.
const EXPECTED_U_HEADERS = [
  'ID',
  'Existing host path(s)',
  'Existing symbol / stable anchor',
  'Allowed thin connection',
  'Forbidden content',
  'Planned module owner',
  'Planned contract test',
  'Status',
]

// Four exact table headers for the contracts table.
const EXPECTED_CONTRACT_HEADERS = [
  'Contract',
  'Planned test path',
  'Status',
  'Future passing evidence',
]

// Ten exact contract identities in the 06 §5 order.
const EXPECTED_CONTRACT_IDENTITIES = [
  'Empty selection walks the original message chain',
  'Both composer surfaces reach the same controller',
  'Three send points share one ticket preparation',
  '`sessionId` / `runtimeRevision` match ticket',
  'SDK UUID → replay / history / project is one identity',
  'Host tab lifecycle stays independent of the main session',
  'Server auth rejects non-loopback / non-local bearer',
  'Trace / prompt-dump sees secret-turn marker',
  'New resource store keeps unknown fields with old fixture',
  'Removing a tag re-computes all dependents / credentials',
]

const U_IDS = Array.from({ length: 17 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`)

// The §5 contracts whose test file a completed micro-batch already created.
// They must be marked `wired` with a path that exists on disk; the rest stay
// `planned:` with a path that must not exist yet.
const WIRED_CONTRACT_IDENTITIES = new Set([
  'Empty selection walks the original message chain',
  'Both composer surfaces reach the same controller',
  'Three send points share one ticket preparation',
])

const PLANNED_CELL_RE = /^planned:`([-A-Za-z0-9._/]+\.[A-Za-z0-9]+)`$/

export interface HostPathBinding {
  path: string
  anchors: string[]
}

export const EXPECTED_U_HOST_MAPPINGS: Record<string, HostPathBinding[]> = {
  U01: [
    { path: 'desktop/src/components/layout/TabBar.tsx', anchors: ['TabBar'] },
  ],
  U02: [
    { path: 'desktop/src/components/layout/ContentRouter.tsx', anchors: ['ContentRouter'] },
  ],
  U03: [
    { path: 'desktop/src/stores/tabStore.ts', anchors: ['useTabStore'] },
    { path: 'desktop/src/lib/persistenceMigrations.ts', anchors: ['runDesktopPersistenceMigrations'] },
  ],
  U04: [
    { path: 'desktop/src/pages/Settings.tsx', anchors: ['Settings'] },
    { path: 'desktop/src/stores/uiStore.ts', anchors: ['useUIStore'] },
  ],
  U05: [
    { path: 'desktop/src/components/chat/ChatInput.tsx', anchors: ['ChatInput'] },
    { path: 'desktop/src/pages/EmptySession.tsx', anchors: ['EmptySession'] },
  ],
  U06: [
    { path: 'desktop/src/components/chat/composerUtils.ts', anchors: ['findSlashTrigger', 'resolveSlashUiAction'] },
  ],
  U07: [
    { path: 'desktop/src/stores/chatStore.ts', anchors: ['useChatStore', 'sendMessage', 'queueUserMessage', 'sendQueuedUserMessage'] },
  ],
  U08: [
    { path: 'desktop/src/api/websocket.ts', anchors: ['WebSocketManager', 'onMessage', 'wsManager'] },
  ],
  U09: [
    { path: 'desktop/src/lib/desktopHost/types.ts', anchors: ['DesktopHost'] },
    { path: 'desktop/src/lib/desktopHost/electronHost.ts', anchors: ['createElectronHost'] },
    { path: 'desktop/src/lib/desktopHost/browserHost.ts', anchors: ['browserHost'] },
    { path: 'desktop/src/lib/desktopHost/index.ts', anchors: ['createDesktopHost'] },
    { path: 'desktop/electron/preload.ts', anchors: [] },
    { path: 'desktop/electron/ipc/capabilities.ts', anchors: ['validateElectronIpcPayload'] },
    { path: 'desktop/electron/main.ts', anchors: ['registerIpcHandlers'] },
  ],
  U10: [
    { path: 'desktop/electron/main.ts', anchors: ['app.whenReady'] },
    { path: 'desktop/electron/services/keychain.ts', anchors: ['installMacOsChromiumKeychainPromptGuard'] },
  ],
  U11: [
    { path: 'src/server/router.ts', anchors: ['handleApiRequest'] },
    { path: 'src/server/index.ts', anchors: ['startServer', 'startBackgroundIndexesInPriorityOrder'] },
  ],
  U12: [
    { path: 'src/server/ws/events.ts', anchors: ['ClientMessage', 'ServerMessage', 'RUNTIME_CONFIG_APPLIED_EVENT'] },
    { path: 'src/server/ws/handler.ts', anchors: ['getSessionChatActivityState', 'markSessionChatQueued', 'clearLegacySessionChatState'] },
  ],
  U13: [
    { path: 'src/server/services/conversationService.ts', anchors: ['ConversationService', 'sendMessage', 'buildUserContent'] },
  ],
  U14: [
    { path: 'src/server/services/sessionService.ts', anchors: ['sessionService'] },
    { path: 'src/server/services/localIndex/transcriptReducer.ts', anchors: ['reduceTranscript', 'reduceTranscriptWithLocators'] },
    { path: 'src/server/services/localIndex/searchContentProjector.ts', anchors: ['createSearchContentProjector'] },
  ],
  U15: [
    { path: 'src/server/ws/handler.ts', anchors: ['bindTitleSessionOutput', 'sessionTitleState'] },
    { path: 'src/services/api/traceCapture.ts', anchors: ['traceCaptureService'] },
    { path: 'src/services/api/dumpPrompts.ts', anchors: ['createDumpPromptsFetch', 'getDumpPromptsPath'] },
  ],
  U16: [
    { path: 'desktop/src/components/controls/ModelSelector.tsx', anchors: ['ModelSelector'] },
  ],
  U17: [
    { path: 'desktop/src/i18n/locales/en.ts', anchors: ['en'] },
    { path: 'desktop/src/i18n/locales/zh.ts', anchors: ['zh'] },
    { path: 'desktop/src/i18n/locales/jp.ts', anchors: ['jp'] },
    { path: 'desktop/src/i18n/locales/kr.ts', anchors: ['kr'] },
    { path: 'desktop/src/i18n/locales/zh-TW.ts', anchors: [] },
    { path: 'desktop/package.json', anchors: [] },
    { path: 'desktop/bun.lock', anchors: [] },
    { path: 'scripts/quality-gate/modes.ts', anchors: [] },
  ],
}

// ----- Path Containment Helper ------------------------------------------------

export function resolveInsideRepo(p: string): string {
  if (typeof p !== 'string') {
    throw new Error(`path must be string: ${String(p)}`)
  }
  const trimmed = p.trim()
  if (!trimmed) {
    throw new Error('empty path rejected')
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    throw new Error(`absolute path rejected: ${trimmed}`)
  }
  const resolved = path.resolve(REPO_ROOT, trimmed)
  const rel = path.relative(REPO_ROOT, resolved)

  if (!rel || rel === '.' || resolved === REPO_ROOT) {
    throw new Error(`repo root path rejected: ${trimmed}`)
  }
  if (rel === '..') {
    throw new Error(`relative path escapes repo root: ${trimmed}`)
  }
  if (rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error(`relative path escapes repo root: ${trimmed}`)
  }
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error(`relative path became absolute: ${trimmed}`)
  }

  return resolved
}

// ----- Markdown parsing helpers -----------------------------------------------

function loadMap(): string {
  return fs.readFileSync(MAP_PATH, 'utf8')
}

interface URow {
  id: string
  cells: string[]
  status: string
  anchors: string[]
}

function extractSection(text: string, heading: string): string {
  const safe = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`## ${safe}\\s*\\n([\\s\\S]*?)(?=\\n## |\\Z)`)
  const match = re.exec(text)
  if (!match) throw new Error(`section not found: ${heading}`)
  return match[1]!.trim()
}

function splitRow(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return []
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map(c => c.trim())
}

function parseURows(text: string): URow[] {
  const section = extractSection(text, 'U01–U17 host seams')
  const lines = section.split(/\r?\n/)
  const rows: URow[] = []
  for (const line of lines) {
    if (!line.includes('|')) continue
    const cells = splitRow(line)
    if (cells.length === 0) continue
    if (cells[0] === 'ID' || cells.every(c => /^:?-{2,}:?$/.test(c))) continue
    const id = cells[0]!
    if (!U_IDS.includes(id)) continue
    const anchorCell = cells[2] ?? ''
    const anchors = anchorCell
      .split(/<br>|\|/g)
      .map(c => c.trim().replace(/^`|`$/g, ''))
      .filter(c => c && !c.startsWith('('))
    rows.push({ id, cells, status: cells[cells.length - 1] ?? '', anchors })
  }
  return rows
}

interface ContractRow {
  name: string
  testPath: string
  status: string
}

function parseContractRows(text: string): ContractRow[] {
  const section = extractSection(text, 'No-feature regression contracts (06 §5)')
  const lines = section.split(/\r?\n/)
  const rows: ContractRow[] = []
  for (const line of lines) {
    if (!line.includes('|')) continue
    const cells = splitRow(line)
    if (cells.length === 0) continue
    if (cells[0] === 'Contract' || cells.every(c => /^:?-{2,}:?$/.test(c))) continue
    rows.push({ name: cells[0] ?? '', testPath: cells[1] ?? '', status: cells[2] ?? '' })
  }
  return rows
}

function parseHeaders(text: string, sectionHeading: string): string[] {
  const section = extractSection(text, sectionHeading)
  const lines = section.split(/\r?\n/)
  for (const line of lines) {
    if (!line.includes('|')) continue
    const cells = splitRow(line)
    if (cells.length === 0) continue
    if (cells[0] === 'ID' || cells[0] === 'Contract') return cells
  }
  throw new Error(`headers not found in section: ${sectionHeading}`)
}

function extractBaseHead(text: string): string {
  const re = /upstreamBaseHead:\s*([0-9a-f]{40})/
  const match = re.exec(text)
  if (!match) throw new Error('upstreamBaseHead missing')
  return match[1]!
}

function extractScope(text: string): string {
  const re = /scope:\s*([^\n]+)/
  const match = re.exec(text)
  if (!match) throw new Error('scope missing')
  return match[1]!.trim()
}

function extractBacktickPaths(s: string): string[] {
  const out: string[] = []
  const re = /`([-A-Za-z0-9._/]+\.[A-Za-z0-9]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    out.push(m[1]!)
  }
  return out
}

function cleanBacktickPath(p: string): string {
  return p
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .trim()
}

// ----- Validators (extracted so they can be re-applied to mutated text) ----

export function validateMap(text: string): {
  rows: URow[]
  contracts: ContractRow[]
  planned: string[]
  baseHead: string
  scope: string
  uHeaders: string[]
  contractHeaders: string[]
} {
  const baseHead = extractBaseHead(text)
  expect(baseHead).toBe(EXPECTED_BASE_HEAD)

  const scope = extractScope(text)
  expect(scope).toBe(EXPECTED_SCOPE)

  const uHeaders = parseHeaders(text, 'U01–U17 host seams')
  expect(uHeaders).toEqual(EXPECTED_U_HEADERS)

  const contractHeaders = parseHeaders(text, 'No-feature regression contracts (06 §5)')
  expect(contractHeaders).toEqual(EXPECTED_CONTRACT_HEADERS)

  const WIRED_U_IDS = new Set([
    'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U09', 'U10', 'U11', 'U12', 'U13', 'U15', 'U17',
  ])
  const WIRED_CELL_RE = /^`([-A-Za-z0-9._/]+\.[A-Za-z0-9]+)`$/

  const rows = parseURows(text)
  expect(rows.map(r => r.id)).toEqual(U_IDS)
  for (const row of rows) {
    expect(row.cells.length, `${row.id} column count`).toBe(EXPECTED_U_HEADERS.length)
    if (WIRED_U_IDS.has(row.id)) {
      expect(row.status, `${row.id} status`).toBe('wired')
    } else {
      expect(row.status, `${row.id} status`).toBe('not-wired')
    }
  }

  const contracts = parseContractRows(text)
  expect(contracts.map(c => c.name)).toEqual(EXPECTED_CONTRACT_IDENTITIES)
  for (const c of contracts) {
    const expectedStatus = WIRED_CONTRACT_IDENTITIES.has(c.name) ? 'wired' : 'planned'
    expect(c.status, `contract "${c.name}" status`).toBe(expectedStatus)
  }

  // 1. Validate paths: 17 module owners + 17 U contract tests + 10 contract test paths = 44
  const planned: string[] = []
  for (const row of rows) {
    const isWired = WIRED_U_IDS.has(row.id)
    const ownerCell = row.cells[5] ?? ''
    const mOwner = isWired
      ? (WIRED_CELL_RE.exec(ownerCell) || PLANNED_CELL_RE.exec(ownerCell))
      : PLANNED_CELL_RE.exec(ownerCell)
    if (!mOwner) {
      throw new Error(`${row.id} Planned module owner "${ownerCell}" does not match path grammar`)
    }
    const ownerPath = mOwner[1]!
    planned.push(ownerPath)
    const ownerResolved = resolveInsideRepo(ownerPath)
    if (isWired) {
      expect(fs.existsSync(ownerResolved), `wired module owner must exist on disk: ${ownerPath}`).toBe(true)
    } else {
      expect(fs.existsSync(ownerResolved), `planned path must not yet exist on disk: ${ownerPath}`).toBe(false)
    }

    const testCell = row.cells[6] ?? ''
    const mTest = isWired
      ? (WIRED_CELL_RE.exec(testCell) || PLANNED_CELL_RE.exec(testCell))
      : PLANNED_CELL_RE.exec(testCell)
    if (!mTest) {
      throw new Error(`${row.id} Planned contract test "${testCell}" does not match path grammar`)
    }
    const testPath = mTest[1]!
    planned.push(testPath)
    const testResolved = resolveInsideRepo(testPath)
    if (isWired) {
      expect(fs.existsSync(testResolved), `wired contract test must exist on disk: ${testPath}`).toBe(true)
    } else {
      expect(fs.existsSync(testResolved), `planned path must not yet exist on disk: ${testPath}`).toBe(false)
    }
  }

  for (const c of contracts) {
    const isWired = WIRED_CONTRACT_IDENTITIES.has(c.name)
    const mContract = isWired
      ? (WIRED_CELL_RE.exec(c.testPath) || PLANNED_CELL_RE.exec(c.testPath))
      : PLANNED_CELL_RE.exec(c.testPath)
    if (!mContract) {
      throw new Error(`Contract "${c.name}" Planned test path "${c.testPath}" does not match planned:\`repo/path\` grammar`)
    }
    const contractPath = mContract[1]!
    planned.push(contractPath)
    const resolved = resolveInsideRepo(contractPath)
    if (isWired) {
      expect(fs.existsSync(resolved), `wired contract test must exist on disk: ${contractPath}`).toBe(true)
    } else {
      expect(fs.existsSync(resolved), `planned path must not yet exist on disk: ${contractPath}`).toBe(false)
    }
  }

  expect(planned.length, 'Total planned paths must equal 44').toBe(44)
  expect(new Set(planned).size, 'Unique planned paths must equal 44').toBe(44)

  // 2. Validate Host paths & exact path->anchors bindings
  for (const row of rows) {
    const hostCell = row.cells[1] ?? ''
    const parsedHostPaths = extractBacktickPaths(hostCell).map(cleanBacktickPath)
    const expectedBindings = EXPECTED_U_HOST_MAPPINGS[row.id]
    if (!expectedBindings) {
      throw new Error(`missing expected host mapping for ${row.id}`)
    }
    const expectedHostPaths = expectedBindings.map(b => b.path)
    expect(parsedHostPaths, `${row.id} host paths mismatch`).toEqual(expectedHostPaths)

    // All host paths must exist inside the repo
    for (const hostPath of parsedHostPaths) {
      const resolved = resolveInsideRepo(hostPath)
      expect(fs.existsSync(resolved), `${row.id} existing host path must exist: ${hostPath}`).toBe(true)
    }

    // Anchor list must match expected mapped anchors
    const expectedRowAnchors = expectedBindings.flatMap(b => b.anchors)
    expect(row.anchors, `${row.id} anchor list mismatch`).toEqual(expectedRowAnchors)

    // Each anchor must be searched ONLY in its designated host file (no hostPaths.some!)
    for (const binding of expectedBindings) {
      const resolved = resolveInsideRepo(binding.path)
      const fileContent = fs.readFileSync(resolved, 'utf8')
      for (const anchor of binding.anchors) {
        if (!fileContent.includes(anchor)) {
          throw new Error(`${row.id} anchor "${anchor}" not found in mapped file "${binding.path}"`)
        }
      }
    }
  }

  return { rows, contracts, planned, baseHead, scope, uHeaders, contractHeaders }
}

// ----- Tests ---------------------------------------------------------------

describe('integration-map metadata', () => {
  it('passes the full inventory check', () => {
    const text = loadMap()
    validateMap(text)
  })

  it('contains exactly the 10 exact §5 contract identities in order', () => {
    const text = loadMap()
    const contracts = parseContractRows(text)
    expect(contracts.map(c => c.name)).toEqual(EXPECTED_CONTRACT_IDENTITIES)
  })

  it('contains exactly the 8 exact U-table headers', () => {
    const text = loadMap()
    expect(parseHeaders(text, 'U01–U17 host seams')).toEqual(EXPECTED_U_HEADERS)
  })

  it('pins exact host paths and mapped anchors for U01-U17', () => {
    const text = loadMap()
    const { rows } = validateMap(text)
    for (const row of rows) {
      const expectedBindings = EXPECTED_U_HOST_MAPPINGS[row.id]!
      const parsedHostPaths = extractBacktickPaths(row.cells[1] ?? '').map(cleanBacktickPath)
      expect(parsedHostPaths).toEqual(expectedBindings.map(b => b.path))
      expect(row.anchors).toEqual(expectedBindings.flatMap(b => b.anchors))
    }
  })

  it('rejects deletion of required host paths from U03, U09, or U15', () => {
    const text = loadMap()

    // Test U03: delete tabStore.ts
    const targetU03 = '| U03 | `desktop/src/stores/tabStore.ts`<br>'
    expect(text.includes(targetU03)).toBe(true)
    const tamperedU03 = text.replace(targetU03, '| U03 | ')
    expect(tamperedU03.includes(targetU03)).toBe(false)
    expect(() => validateMap(tamperedU03)).toThrow()

    // Test U09: delete capabilities.ts
    const targetU09 = '`desktop/electron/ipc/capabilities.ts`<br>'
    expect(text.includes(targetU09)).toBe(true)
    const tamperedU09 = text.replace(targetU09, '')
    expect(tamperedU09.includes(targetU09)).toBe(false)
    expect(() => validateMap(tamperedU09)).toThrow()

    // Test U15: delete handler.ts
    const targetU15 = '| U15 | `src/server/ws/handler.ts`<br>'
    expect(text.includes(targetU15)).toBe(true)
    const tamperedU15 = text.replace(targetU15, '| U15 | ')
    expect(tamperedU15.includes(targetU15)).toBe(false)
    expect(() => validateMap(tamperedU15)).toThrow()
  })

  // ----- Mutation: replace a contract identity -------------------------------

  it('rejects a swapped §5 contract identity', () => {
    const text = loadMap()
    const target = EXPECTED_CONTRACT_IDENTITIES[2]!
    const replacement = 'Three send points share one secret credential'
    expect(text.includes(target)).toBe(true)
    const tampered = text.replace(target, replacement)
    expect(tampered.includes(target)).toBe(false)
    expect(tampered.includes(replacement)).toBe(true)
    expect(() => validateMap(tampered)).toThrow()
  })

  // ----- Mutation: replace an anchor ----------------------------------------

  it('rejects a swapped anchor token', () => {
    const text = loadMap()
    const target = '`useTabStore`'
    const replacement = '`useTabStoreToNowhere`'
    expect(text.includes(target)).toBe(true)
    const tampered = text.replace(target, replacement)
    expect(tampered.includes(target)).toBe(false)
    expect(tampered.includes(replacement)).toBe(true)
    expect(() => validateMap(tampered)).toThrow()
  })

  it('rejects an anchor token moved to a different host file', () => {
    const text = loadMap()
    // In U03, swap useTabStore with runDesktopPersistenceMigrations (from another file in the same row)
    const target = '`useTabStore`<br>`runDesktopPersistenceMigrations`'
    const replacement = '`runDesktopPersistenceMigrations`<br>`runDesktopPersistenceMigrations`'
    expect(text.includes(target)).toBe(true)
    const tampered = text.replace(target, replacement)
    expect(tampered.includes(target)).toBe(false)
    expect(tampered.includes(replacement)).toBe(true)
    expect(() => validateMap(tampered)).toThrow()
  })

  // ----- Mutation: remove a planned: prefix ---------------------------------

  it('rejects a missing planned: prefix on a future module path', () => {
    const text = loadMap()
    const target = 'planned:`desktop/src/features/managed-resources/integration/sensitiveSwitchHint.tsx`'
    const replacement = '`desktop/src/features/managed-resources/integration/sensitiveSwitchHint.tsx`'
    expect(text.includes(target)).toBe(true)
    const tampered = text.replace(target, replacement)
    expect(tampered.includes(target)).toBe(false)
    expect(tampered.includes(replacement)).toBe(true)
    expect(() => validateMap(tampered)).toThrow()
  })

  // ----- Mutation: planned path outside the repository ----------------------

  it('rejects a planned path that escapes the repository root', () => {
    const text = loadMap()
    const target = 'planned:`desktop/src/features/managed-resources/integration/sensitiveSwitchHint.tsx`'
    const replacement = 'planned:`../outside.ts`'
    expect(text.includes(target)).toBe(true)
    const tampered = text.replace(target, replacement)
    expect(tampered.includes(target)).toBe(false)
    expect(tampered.includes(replacement)).toBe(true)
    expect(() => validateMap(tampered)).toThrow()
  })
})