import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizePath } from '../../../src/utils/sessionStoragePortable'
import { DESKTOP_SMOKE_COMPOSER_SELECTOR, DESKTOP_SMOKE_RUN_SELECTOR } from './execute'

export const SESSION_ISOLATION_TITLE = 'Duplicate history isolation fixture'
export const SESSION_ISOLATION_ERROR = "API Error: 429 You've reached your 5-hour usage limit. https://www.kimi.com/membership/subscription?tab=quota"
export const SESSION_ISOLATION_PROMPT = 'Fresh session isolation smoke'

type BrowserStep = (args: string[], options?: { timeoutMs?: number; allowFailure?: boolean }) => Promise<{ stdout: string; stderr: string }>
type HistoryFixture = { sessionId: string; path: string; bytes: string }

/** Compaction in older transcripts could append the same message UUID again. */
export function seedDesktopUiDuplicateHistory(configDir: string, workDir: string): HistoryFixture {
  const sessionId = randomUUID()
  const directory = join(configDir, 'projects', sanitizePath(workDir))
  const timestamp = new Date().toISOString()
  const errors = ['error-a', 'error-b'].map(uuid => ({
    type: 'assistant', uuid, sessionId, timestamp, isApiErrorMessage: true,
    message: { id: `msg-${uuid}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: SESSION_ISOLATION_ERROR }] },
  }))
  const entries = [
    { type: 'session-meta', isMeta: true, workDir, timestamp },
    { type: 'user', uuid: 'old-user', sessionId, timestamp, message: { role: 'user', content: 'Old isolated history' } },
    ...errors,
    ...errors,
    { type: 'custom-title', customTitle: SESSION_ISOLATION_TITLE, sessionId },
  ]
  const bytes = `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`
  const path = join(directory, `${sessionId}.jsonl`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, bytes)
  return { sessionId, path, bytes }
}

export async function runDesktopUiSessionIsolationSmoke(options: {
  fixture: HistoryFixture; artifactDir: string; browserStep: BrowserStep
}) {
  const { fixture, artifactDir, browserStep } = options
  const activePanel = '[data-testid="session-tab-panel"][aria-hidden="false"]'
  const draftPanel = '[data-testid="new-session-draft-panel"][aria-hidden="false"]'
  const containsError = (selector: string) =>
    `document.querySelector(${JSON.stringify(selector)})?.innerText.includes(${JSON.stringify(SESSION_ISOLATION_ERROR)})`

  // Open the persisted history in the existing renderer. Reloading after the
  // next switch would clear orphaned React nodes and miss this regression.
  await browserStep(['find', 'text', SESSION_ISOLATION_TITLE, 'click', '--exact'])
  await browserStep(['wait', '--fn', containsError(activePanel)])
  await browserStep(['click', 'button[aria-label="New session"]'])
  await browserStep(['wait', `${draftPanel} ${DESKTOP_SMOKE_COMPOSER_SELECTOR}`])
  await browserStep(['wait', '--fn', `!(${containsError(draftPanel)})`])
  await browserStep(['type', `${draftPanel} ${DESKTOP_SMOKE_COMPOSER_SELECTOR}`, SESSION_ISOLATION_PROMPT])
  await browserStep(['click', `${draftPanel} :is(${DESKTOP_SMOKE_RUN_SELECTOR})`])
  await browserStep(['wait', '--fn', `document.querySelector(${JSON.stringify(activePanel)})?.innerText.includes(${JSON.stringify(`Echo: ${SESSION_ISOLATION_PROMPT}`)})`])

  const rendered = await browserStep(['get', 'text', activePanel])
  writeFileSync(join(artifactDir, 'session-isolation-content.txt'), rendered.stdout)
  if (rendered.stdout.includes(SESSION_ISOLATION_ERROR) || rendered.stdout.includes('kimi.com/membership')) {
    throw new Error('Old API error nodes leaked into the fresh session after its first send')
  }
  const selected = await browserStep(['eval', "JSON.parse(localStorage.getItem('cc-haha-open-tabs')).activeTabId"])
  if (selected.stdout.includes(fixture.sessionId)) throw new Error('First send kept the old session selected')
  if (readFileSync(fixture.path, 'utf8') !== fixture.bytes) {
    throw new Error('Opening duplicate history mutated the original transcript')
  }
  await browserStep(['screenshot', join(artifactDir, 'session-isolation.png')], { allowFailure: true })
}
