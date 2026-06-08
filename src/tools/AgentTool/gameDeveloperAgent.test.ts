import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { parseAgentFromMarkdown } from './loadAgentsDir.js'

// The game-developer agent ships as a PROJECT-level agent (.claude/agents),
// not a built-in. This test loads the real file through the same parser the
// runtime uses, to prove the frontmatter is valid and the strengthened
// grounding guidance is present.
const AGENT_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '.claude',
  'agents',
  'game-developer.md',
)

describe('game-developer project agent', () => {
  test('parses from .claude/agents/game-developer.md with expected metadata', () => {
    const raw = readFileSync(AGENT_PATH, 'utf-8')
    const { frontmatter, content } = parseFrontmatter(raw, AGENT_PATH)

    const agent = parseAgentFromMarkdown(
      AGENT_PATH,
      'project',
      frontmatter,
      content,
      'projectSettings',
    )

    expect(agent).not.toBeNull()
    expect(agent?.agentType).toBe('game-developer')
    expect(agent?.source).toBe('projectSettings')
    expect(agent?.color).toBe('purple')
    expect(agent?.model).toBe('inherit')
    // tools omitted in frontmatter => undefined (all tools allowed)
    expect(agent?.tools).toBeUndefined()
    expect(agent?.whenToUse).toContain('Unity')
  })

  test('system prompt enforces engine grounding via codegraph and official docs', () => {
    const raw = readFileSync(AGENT_PATH, 'utf-8')
    const { frontmatter, content } = parseFrontmatter(raw, AGENT_PATH)

    const agent = parseAgentFromMarkdown(
      AGENT_PATH,
      'project',
      frontmatter,
      content,
      'projectSettings',
    )
    const prompt = agent?.getSystemPrompt() ?? ''

    expect(prompt.length).toBeGreaterThan(0)
    // Strengthened guidance: prefer real installed-engine symbols over memory.
    expect(prompt).toContain('codegraph')
    // Strengthened guidance: verify uncertain APIs against official docs.
    expect(prompt.toLowerCase()).toContain('official doc')
    // Detects the installed engine version rather than assuming.
    expect(prompt).toContain('ProjectVersion.txt')
  })
})
