import { afterEach, describe, expect, test } from 'bun:test'
import { toJSONSchema } from 'zod/v4'

import type { ToolUseContext } from '../../Tool.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerUpdateConfigSkill } from './updateConfig.js'

const SCHEMA_HEADING = '## Full Settings JSON Schema'
const SCHEMA_FENCE_OPEN = `${SCHEMA_HEADING}\n\n\`\`\`json\n`

afterEach(() => {
  clearBundledSkills()
})

/**
 * Invoke the bundled skill the way SkillTool does: register it, then call
 * getPromptForCommand on the registered command.
 */
async function invokeUpdateConfig(args: string): Promise<string> {
  registerUpdateConfigSkill()
  const skill = getBundledSkills().find(
    (command) => command.name === 'update-config',
  )
  if (skill?.type !== 'prompt') {
    throw new Error('Expected the bundled update-config prompt skill')
  }
  const blocks = await skill.getPromptForCommand(
    args,
    {} as ToolUseContext,
  )
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Pull the JSON schema back out of the fenced block in the prompt. */
function extractEmbeddedSchema(prompt: string): Record<string, unknown> {
  const start = prompt.indexOf(SCHEMA_FENCE_OPEN)
  expect(start).toBeGreaterThanOrEqual(0)
  const body = prompt.slice(start + SCHEMA_FENCE_OPEN.length)
  const end = body.indexOf('\n```')
  expect(end).toBeGreaterThan(-1)
  return JSON.parse(body.slice(0, end)) as Record<string, unknown>
}

describe('bundled update-config skill', () => {
  test('a normal invocation returns the settings JSON schema', async () => {
    const prompt = await invokeUpdateConfig('allow npm commands')
    const schema = extractEmbeddedSchema(prompt)

    expect(schema.type).toBe('object')
    const properties = schema.properties as Record<string, unknown>
    expect(properties.permissions).toBeDefined()
    expect(properties.hooks).toBeDefined()
    // The union that contains a bare z.undefined() is what used to throw.
    expect(properties.enabledPlugins).toBeDefined()
    expect(prompt).toContain('allow npm commands')
  })

  test('embeds the input-mode schema, not the parsed output schema', async () => {
    const embedded = extractEmbeddedSchema(
      await invokeUpdateConfig('set DEBUG=true'),
    )

    expect(embedded).toEqual(
      toJSONSchema(SettingsSchema(), {
        io: 'input',
        unrepresentable: 'any',
      }),
    )
  })

  test('the [hooks-only] early return still skips the schema', async () => {
    const prompt = await invokeUpdateConfig('[hooks-only] add a PreToolUse hook')

    expect(prompt).toContain('add a PreToolUse hook')
    expect(prompt).not.toContain(SCHEMA_HEADING)
  })
})
