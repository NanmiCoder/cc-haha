import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getSoloPipelineSystemPrompt,
  isSoloPipelineMode,
  _SOLO_PIPELINE_INTERNALS,
} from './soloPipelinePrompt'

const ENV_KEY = _SOLO_PIPELINE_INTERNALS.SOLO_PIPELINE_ENV_VAR
const ORIGINAL_ENV = process.env[ENV_KEY]

beforeEach(() => {
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (ORIGINAL_ENV !== undefined) {
    process.env[ENV_KEY] = ORIGINAL_ENV
  } else {
    delete process.env[ENV_KEY]
  }
})

describe('isSoloPipelineMode', () => {
  it('returns false when the env var is unset', () => {
    expect(isSoloPipelineMode()).toBe(false)
  })

  it('returns false for empty / "false" / "0" values', () => {
    process.env[ENV_KEY] = ''
    expect(isSoloPipelineMode()).toBe(false)
    process.env[ENV_KEY] = 'false'
    expect(isSoloPipelineMode()).toBe(false)
    process.env[ENV_KEY] = '0'
    expect(isSoloPipelineMode()).toBe(false)
  })

  it('stays gated on the COORDINATOR_MODE bundle flag — without it, even truthy env values return false', () => {
    // The feature() call is a bundle-time flag (bun:bundle). In a
    // unit-test bundle it evaluates falsy, so the predicate MUST
    // short-circuit before reading the env var. This pins the gate
    // behavior — anyone who removes the feature() check (e.g. to
    // "simplify" tests) breaks the production rollout safety.
    process.env[ENV_KEY] = '1'
    expect(isSoloPipelineMode()).toBe(false)
    process.env[ENV_KEY] = 'true'
    expect(isSoloPipelineMode()).toBe(false)
  })
})

describe('getSoloPipelineSystemPrompt — invariants', () => {
  // Lock the parts of the prompt the wiring layer (and downstream
  // specialists) will assume exist. Cosmetic edits to the prompt are
  // fine; structural changes — removing a stage, dropping the human
  // gate, removing Stage 0 — must touch this test.

  const prompt = getSoloPipelineSystemPrompt()

  it('opens with the Solo Pipeline mode header', () => {
    expect(prompt.startsWith('# Solo Pipeline Mode')).toBe(true)
  })

  it('includes Stage 0 intent triage with all three classifications', () => {
    expect(prompt).toContain('STAGE 0')
    expect(prompt).toContain('CHAT / QUESTION')
    expect(prompt).toContain('TASK')
    expect(prompt).toContain('AMBIGUOUS')
  })

  it('explicitly says NOT to start the pipeline for chat', () => {
    // The "doesn't fire on hello" UX hard requirement — must remain.
    expect(prompt).toContain('Do NOT start the pipeline')
    expect(prompt).toContain('Never run the pipeline for chat')
  })

  it('declares all five Solo pipeline stages', () => {
    expect(prompt).toMatch(/1\.\s+\*\*PLAN GATE/)
    expect(prompt).toMatch(/2\.\s+\*\*IMPLEMENT\*\*/)
    expect(prompt).toMatch(/3\.\s+\*\*TEST\*\*/)
    expect(prompt).toMatch(/4\.\s+\*\*REVIEW\*\*/)
    expect(prompt).toMatch(/5\.\s+\*\*LAND\*\*/)
  })

  it('requires real AgentTool fan-out for the A/B/C Plan Gate before implementation', () => {
    expect(prompt).toContain('A/B/C Plan Gate')
    expect(prompt).toContain('Solo Council')
    expect(prompt).toContain('A = Planner')
    expect(prompt).toContain('B = Reviewer')
    expect(prompt).toContain('C = Critic')
    expect(prompt).toContain('final execution plan')
    expect(prompt).toContain('SOLO_COUNCIL_SYNTHESIS_START')
    expect(prompt).toContain('SOLO_COUNCIL_SYNTHESIS_END')
    expect(prompt).toContain('Do not simulate')
    expect(prompt).toContain('[Solo Council: Planner]')
    expect(prompt).toContain('[Solo Council: Reviewer]')
    expect(prompt).toContain('[Solo Council: Critic]')
    expect(prompt).toContain('subagent_type: "Plan"')
    expect(prompt).toContain('subagent_type: "plan-reviewer"')
    expect(prompt).toContain('subagent_type: "plan-critic"')
    expect(prompt).toContain('Do not enter Stage 2 until all Council agents have reported back')
  })

  it('keeps the HUMAN GATE in Stage 4 (the safety contract)', () => {
    // Auto-merging review without explicit user approval would
    // defeat the whole point of Solo. Anyone who edits the prompt
    // and accidentally drops this MUST update the test on purpose.
    expect(prompt).toContain('HUMAN GATE')
    expect(prompt).toContain('Approve and land?')
    expect(prompt).toContain('yes / changes / abort')
    expect(prompt).toContain('Do NOT proceed to Stage 5 without an explicit yes')
  })

  it('declares the entry-stage shortcuts the suggestion engine emits', () => {
    // Each value of `entryStage` in soloSuggestions.ts MUST have a
    // matching handler in the prompt; otherwise a `'review'`-entry
    // suggestion would silently restart from plan.
    expect(prompt).toContain("entryStage = 'review'")
    expect(prompt).toContain("entryStage = 'land'")
  })

  it('repeats git-safety rules in Stage 5 so landing does not push to main', () => {
    expect(prompt).toContain('never push to main directly')
    expect(prompt).toContain('never commit without explicit ask')
  })
})

describe('SOLO_PIPELINE_PROMPT — text shape', () => {
  it('is non-trivial in length but not pathologically large', () => {
    const text = _SOLO_PIPELINE_INTERNALS.SOLO_PIPELINE_PROMPT
    // Loose envelope — flag accidental truncation or accidental
    // tripling. ~3-6kB is the right ballpark for this template.
    expect(text.length).toBeGreaterThan(2_000)
    expect(text.length).toBeLessThan(10_000)
  })
})
