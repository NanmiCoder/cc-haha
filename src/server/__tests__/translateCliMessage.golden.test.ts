import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { translateCliMessage } from '../ws/handler.js'
import { goldenScenarios } from './translateCliMessage.golden.js'

const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/translate-cli-message.golden.json', import.meta.url))
const UPDATE = process.env.UPDATE_TRANSLATE_GOLDEN === '1'

type GoldenStep = { in: string; out: unknown[] }
type GoldenFile = Record<string, GoldenStep[]>

/**
 * Replay one scenario against a fresh session id.
 *
 * The reducer's hidden inputs (`sessionStreamStates`, `sessionSlashCommands`,
 * `sessionStopRequested`, `agentStopRequestedSessions`) are all keyed by session id,
 * so a unique id per run is full isolation with no production seam.
 */
function replay(scenarioId: string, messages: Array<Record<string, unknown>>, salt: string): GoldenStep[] {
  const sessionId = `golden-${scenarioId}-${salt}`
  return messages.map((message) => ({
    in: describeFrame(message),
    out: JSON.parse(JSON.stringify(translateCliMessage(message, sessionId))) as unknown[],
  }))
}

function describeFrame(message: Record<string, unknown>): string {
  const type = String(message.type ?? 'unknown')
  const subtype = typeof message.subtype === 'string' ? `/${message.subtype}` : ''
  const event = message.event as { type?: string } | undefined
  const eventType = event?.type ? `/${event.type}` : ''
  const request = message.request as { subtype?: string } | undefined
  const requestType = request?.subtype ? `/${request.subtype}` : ''
  return `${type}${subtype}${eventType}${requestType}`
}

function loadGolden(): GoldenFile {
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(
      `Missing golden file ${GOLDEN_PATH}. Regenerate it with UPDATE_TRANSLATE_GOLDEN=1 and review the diff before committing.`,
    )
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile
}

if (UPDATE) {
  const regenerated: GoldenFile = {}
  for (const scenario of goldenScenarios) {
    regenerated[scenario.id] = replay(scenario.id, scenario.messages, 'record')
  }
  writeFileSync(GOLDEN_PATH, JSON.stringify(regenerated, null, 2) + '\n')
}

describe('translateCliMessage golden output', () => {
  const golden = loadGolden()

  /**
   * A hand-edited or partially regenerated golden file is exactly when these tests
   * matter most, so a missing entry must name the scenario rather than surface as a
   * confusing undefined dereference.
   */
  function stepsFor(id: string): GoldenStep[] {
    const steps = golden[id]
    if (!steps) {
      throw new Error(`Golden file has no entry for "${id}". Regenerate with UPDATE_TRANSLATE_GOLDEN=1.`)
    }
    return steps
  }

  test('records every scenario and nothing else', () => {
    // A scenario added without regenerating would otherwise be silently unchecked,
    // and one deleted from the catalog would leave dead expectations behind.
    expect(Object.keys(golden).sort()).toEqual(goldenScenarios.map((scenario) => scenario.id).sort())
  })

  test('is not vacuous: every scenario emits client messages unless it declares otherwise', () => {
    // Without this, a change that made the reducer return [] for everything would
    // regenerate into an all-empty golden file and pass forever.
    for (const scenario of goldenScenarios) {
      const emitted = stepsFor(scenario.id).reduce((total, step) => total + step.out.length, 0)
      if (scenario.expectsNoClientOutput) {
        // Silence is the pinned behavior here: forwarding these frames would leak
        // runtime internals into the chat transcript.
        expect(emitted, `${scenario.id} now forwards frames it used to suppress`).toBe(0)
        continue
      }
      expect(emitted, `${scenario.id} emitted no client messages`).toBeGreaterThan(0)
    }
    const total = Object.values(golden).reduce(
      (sum, steps) => sum + steps.reduce((inner, step) => inner + step.out.length, 0),
      0,
    )
    expect(total).toBeGreaterThan(40)
  })

  for (const scenario of goldenScenarios) {
    test(`${scenario.id}: ${scenario.description}`, () => {
      expect(replay(scenario.id, scenario.messages, 'verify')).toEqual(stepsFor(scenario.id))
    })
  }

  test('is independent of session id and of replay order', () => {
    // Proves the per-session-id isolation this harness relies on: if the reducer
    // ever leaks state through a module-level container that is not keyed by
    // session, replaying in reverse under different ids would drift.
    for (const scenario of [...goldenScenarios].reverse()) {
      expect(
        replay(scenario.id, scenario.messages, 'reordered'),
        `${scenario.id} depends on global state or replay order`,
      ).toEqual(stepsFor(scenario.id))
    }
  })

  test('covers the frame types the reducer actually branches on', () => {
    const source = readFileSync(fileURLToPath(new URL('../ws/handler.ts', import.meta.url)), 'utf8')
    const reducer = source.slice(source.indexOf('export function translateCliMessage'))
    const branchSubtypes = [...reducer.matchAll(/subtype === '([a-z_]+)'/g)].map((match) => match[1])
    const covered = new Set(
      goldenScenarios.flatMap((scenario) => scenario.messages.flatMap((message) => [
        message.subtype,
        (message.request as { subtype?: string } | undefined)?.subtype,
      ])).filter(Boolean),
    )

    // Not every branch needs a scenario, but the gap must stay visible instead of
    // quietly growing as new subtypes are added to a 612-line switch. Shrink this
    // list by adding a scenario; never by deleting the assertion.
    const uncovered = [...new Set(branchSubtypes)].filter((subtype) => !covered.has(subtype)).sort()
    expect(uncovered).toEqual(['memory_saved', 'session_state_changed'])
  })
})
