import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'

const root = join(import.meta.dir, '..', '..', '..')
const MARKER = 'LEAN_SKILL_AT_FILE_MARKER_91c2'
const LEAN_TOOLS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'Write']

/** Runs the real CLI once on `/fixture-skill @README.md` and returns the first agent request sent upstream. */
async function firstAgentRequest(profile: 'standard' | 'lean') {
  const home = mkdtempSync(join(tmpdir(), 'lean-skill-at-file-'))
  const workDir = join(home, 'project')
  const skillDir = join(workDir, '.claude', 'skills', 'fixture-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: fixture-skill\ndescription: fixture\n---\nSKILL_BODY: review $ARGUMENTS')
  writeFileSync(join(workDir, 'README.md'), `# readme\n${MARKER}\n`)
  const requests: Array<{ tools?: Array<{ name?: string }>, messages?: unknown }> = []
  const upstream = startMockLlmServer(request => {
    if (request.tools?.some(tool => tool.name === 'Read')) requests.push(request)
    return { kind: 'message', content: [{ type: 'text', text: 'DONE' }], stopReason: 'end_turn' }
  })
  try {
    const env: Record<string, string> = {
      ...createSandboxedTestEnvironment(home, {
        ANTHROPIC_BASE_URL: upstream.url,
        ANTHROPIC_API_KEY: 'fixture-lean-attachments-key',
        CALLER_DIR: workDir,
        CC_HAHA_SKIP_DOTENV: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      }),
    }
    delete env.NODE_ENV
    const child = Bun.spawn([
      process.execPath, '--no-env-file', '--preload', join(root, 'preload.ts'), join(root, 'src/entrypoints/cli.tsx'),
      '--print', '--agent-profile', profile, '--model', 'mock-model', '--permission-mode', 'bypassPermissions', '/fixture-skill @README.md',
    ], { cwd: workDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env })
    const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    expect(requests.length).toBeGreaterThan(0)
    return requests[0]!
  } finally {
    await upstream.stop()
    rmSync(home, { recursive: true, force: true })
  }
}

// `@file` in a skill invocation is user-supplied context. Standard attaches the file; lean used to
// return before attachment generation, so the mention reached the model as bare text.
for (const profile of ['standard', 'lean'] as const) {
  test(`${profile} attaches the file mentioned in a /skill invocation`, async () => {
    const request = await firstAgentRequest(profile)
    const body = JSON.stringify(request.messages)
    expect(body).toContain('SKILL_BODY')
    expect(body).toContain(MARKER)
    if (profile === 'lean') {
      // Attaching a mentioned file must not widen the lean tool pool.
      expect((request.tools ?? []).map(tool => tool.name).sort()).toEqual(LEAN_TOOLS)
    }
  }, 90_000)
}
