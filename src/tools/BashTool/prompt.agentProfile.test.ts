import { afterAll, afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { setAgentProfile } from '../../utils/agentProfile.js'

// The description reads git/sandbox settings and timeout variables: keep them in a
// throwaway HOME / CLAUDE_CONFIG_DIR so the pinned baseline is host-independent.
const originalEnv = { ...process.env }
const sandboxHome = mkdtempSync(join(tmpdir(), 'bash-prompt-'))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(sandboxHome, {}, originalEnv))
const { getSimplePrompt } = await import('./prompt.js')
afterEach(() => {
  setAgentProfile('standard')
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
})
afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(sandboxHome, { recursive: true, force: true })
})

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const GIT_HEADING = '# Committing changes with git'
// Measured ~4.5KB for lean vs ~9.8KB standard (the commit/PR manual is ~6KB).
const LEAN_GIT_SECTION_BUDGET_BYTES = 1024
const LEAN_DESCRIPTION_BUDGET_BYTES = 4700

test('lean Bash instructions do not recommend unavailable slash skills', () => {
  process.env.USER_TYPE = 'ant'
  setAgentProfile('standard')
  const before = getSimplePrompt()
  expect(before).toContain('/commit-push-pr')
  setAgentProfile('lean')
  const lean = getSimplePrompt()
  expect(lean).not.toContain('/commit-push-pr')
  expect(lean).toContain('NEVER skip hooks')
  expect(lean).toContain('quote file paths')
  setAgentProfile('standard')
  expect(getSimplePrompt()).toBe(before)
})

// Pinned before the lean compaction landed. Update only for an intentional change
// to the standard description; lean work must never move it.
test('standard Bash description is byte-identical to the pinned baseline', () => {
  setAgentProfile('standard')
  const standard = getSimplePrompt()
  expect(standard).toContain('# Creating pull requests')
  expect(sha256(standard)).toBe('41cafd5561a4f9fd2cefcb06d04ab707c2e158e10fd8013f00b588e969be9b7c')
})

test('lean Bash keeps short git safety rules instead of the commit and PR manual', () => {
  setAgentProfile('standard')
  const standard = getSimplePrompt()
  setAgentProfile('lean')
  const lean = getSimplePrompt()
  expect(lean).not.toContain('# Creating pull requests')
  expect(lean).not.toMatch(/TodoWrite|Agent tool|Monitor tool/)
  const start = lean.indexOf(GIT_HEADING)
  expect(start).toBeGreaterThan(0)
  const git = lean.slice(start)
  for (const rule of [
    /Only commit, push, or open pull requests[^.\n]* when the user explicitly asks/,
    /`git status`[^\n]*`git diff`/,
    /by name[^\n]*`git add -A`/,
    /NEVER update git config, force-push/,
    /create a NEW commit/,
    /cat <<'EOF'/,
  ]) expect(git).toMatch(rule)
  // Hook and amend rules stay in the shared "For git commands" instructions.
  expect(lean).toContain('Never skip hooks (--no-verify)')
  expect(lean).toContain('rather than amending')
  expect(Buffer.byteLength(git)).toBeLessThanOrEqual(LEAN_GIT_SECTION_BUDGET_BYTES)
  expect(Buffer.byteLength(lean)).toBeLessThanOrEqual(LEAN_DESCRIPTION_BUDGET_BYTES)
  // Before the git section lean only drops lines (Monitor guidance in MONITOR_TOOL builds).
  const standardLines = new Set(standard.split('\n'))
  expect(lean.slice(0, start).split('\n').filter(line => !standardLines.has(line))).toEqual([])
})

test('lean Bash drops its git rules when git instructions are disabled', () => {
  process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1'
  setAgentProfile('standard')
  const standard = getSimplePrompt()
  setAgentProfile('lean')
  const lean = getSimplePrompt()
  expect(standard).not.toContain(GIT_HEADING)
  expect(lean).not.toContain(GIT_HEADING)
  expect(lean).toContain('For git commands:')
})
