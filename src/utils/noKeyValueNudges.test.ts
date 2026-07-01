import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression: src/tools/AgentTool/specialistRouter.ts documented that any
 * model-facing message containing `key="value"` attribute fragments tends
 * to make non-Anthropic gateway models switch from real tool_use blocks
 * into textual `<tool_use ...>` XML, breaking every subsequent tool call
 * in the session. The fix landed in specialistRouter.ts but TWO other
 * model-facing nudges still embedded `subagent_type="verification"`
 * style attributes: TodoWriteTool's verification nudge, TaskUpdateTool's
 * verification nudge, and the verification_gate_reminder in messages.ts.
 *
 * This test pins those three call sites: the strings they emit must NOT
 * contain `subagent_type="..."` (or any other `key="value"` near a known
 * Agent parameter name). When someone "fixes" a typo and accidentally
 * reverts to the attribute form, this test fails before the model gets
 * primed into XML mode again.
 */

const REPO_ROOT = join(__dirname, '..', '..')

function loadSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

const FORBIDDEN_KEYS = ['subagent_type', 'description', 'prompt']

function findKeyValueAttrs(source: string): string[] {
  const hits: string[] = []
  for (const key of FORBIDDEN_KEYS) {
    // Match `key="value"` and `key='value'` shapes inside any string
    // literal, with optional whitespace around the `=`. The `subagent_type`
    // identifier appears inside types/code legitimately (e.g. as a property
    // name), so we narrow to "looks like an attribute fragment in a model
    // message" by requiring the backtick or quote *before* the key —
    // i.e. the key sits inside an interpolated string literal.
    const rx = new RegExp(`["'\`\\s][^"'\`\\n]*\\b${key}\\s*=\\s*["'][^"']+["']`, 'g')
    let m: RegExpExecArray | null
    while ((m = rx.exec(source)) !== null) {
      hits.push(m[0])
    }
  }
  return hits
}

describe('model-facing nudges do not embed key="value" attribute fragments', () => {
  it('verification_gate_reminder uses prose, not subagent_type="..."', () => {
    const src = loadSource('src/utils/messages.ts')
    // Slice the relevant case so we don't false-positive on unrelated code.
    const start = src.indexOf("case 'verification_gate_reminder':")
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf("case '", start + 30)
    const block = src.slice(start, end > 0 ? end : start + 4000)
    expect(findKeyValueAttrs(block)).toEqual([])
  })

  it('TodoWriteTool verification nudge uses prose, not subagent_type="..."', () => {
    const src = loadSource('src/tools/TodoWriteTool/TodoWriteTool.ts')
    expect(findKeyValueAttrs(src)).toEqual([])
  })

  it('TaskUpdateTool verification nudge uses prose, not subagent_type="..."', () => {
    const src = loadSource('src/tools/TaskUpdateTool/TaskUpdateTool.ts')
    expect(findKeyValueAttrs(src)).toEqual([])
  })
})
