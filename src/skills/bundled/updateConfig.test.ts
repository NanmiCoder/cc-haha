import { afterEach, describe, expect, test } from 'bun:test'

import type { ToolUseContext } from '../../Tool.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { validateSettingsFileContent } from '../../utils/settings/validation.js'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerSimplifySkill } from './simplify.js'
import { registerUpdateConfigSkill } from './updateConfig.js'

const SCHEMA_HEADING = '## Full Settings JSON Schema'
const SCHEMA_FENCE = `${SCHEMA_HEADING}\n\n\`\`\`json\n`

type SettingsJSONSchema = {
  type: string
  properties: Record<string, {
    type?: string
    additionalProperties?: unknown
    properties?: Record<string, unknown>
  }>
}

afterEach(() => {
  clearBundledSkills()
})

async function invokeUpdateConfig(args: string): Promise<string> {
  registerUpdateConfigSkill()
  const skill = getBundledSkills().find(command => command.name === 'update-config')
  if (skill?.type !== 'prompt') {
    throw new Error('Expected the bundled update-config prompt skill')
  }
  const blocks = await skill.getPromptForCommand(args, {} as ToolUseContext)
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function extractSettingsSchema(prompt: string): SettingsJSONSchema {
  const start = prompt.indexOf(SCHEMA_FENCE)
  expect(start).toBeGreaterThanOrEqual(0)
  const body = prompt.slice(start + SCHEMA_FENCE.length)
  const end = body.indexOf('\n```')
  expect(end).toBeGreaterThan(-1)
  return JSON.parse(body.slice(0, end))
}

describe('bundled update-config skill', () => {
  test('normal invocation embeds the settings schema and preserves representable constraints', async () => {
    const prompt = await invokeUpdateConfig('allow npm commands')
    const schema = extractSettingsSchema(prompt)

    expect(prompt).toContain('allow npm commands')
    expect(schema.type).toBe('object')
    expect(schema.properties.enabledPlugins.type).toBe('object')
    expect(schema.properties.enabledPlugins.additionalProperties).toMatchObject({
      anyOf: [
        { type: 'array', items: { type: 'string' } },
        { type: 'boolean' },
        {},
      ],
    })
    expect(schema.properties.hooks.type).toBe('object')
    expect(schema.properties.permissions.properties?.allow).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    })
    expect(schema.properties.cleanupPeriodDays.type).toBe('integer')
    expect(schema.properties.spinnerVerbs.properties?.mode).toEqual({
      type: 'string',
      enum: ['append', 'replace'],
    })
    expect(schema.properties.respectGitignore.type).toBe('boolean')
    expect(schema.properties.env.additionalProperties).toEqual({ type: 'string' })
    // Input objects can contain keys that parsing strips. Output-mode schema
    // would add additionalProperties: false here and narrow the prompt.
    expect(schema.properties.fileSuggestion).not.toHaveProperty('additionalProperties')
    expect(schema.properties.fileSuggestion.properties?.command).toEqual({ type: 'string' })
  })

  test('an invocation without arguments still returns the complete prompt', async () => {
    const prompt = await invokeUpdateConfig('')

    expect(extractSettingsSchema(prompt).properties.model.type).toBe('string')
    expect(prompt).not.toContain('## User Request')
  })

  test('[hooks-only] still returns hook guidance without generating the settings schema', async () => {
    const prompt = await invokeUpdateConfig('[hooks-only] add a PreToolUse hook')

    expect(prompt).toContain('## Hooks Configuration')
    expect(prompt).toContain('## Task\n\nadd a PreToolUse hook')
    expect(prompt).not.toContain(SCHEMA_HEADING)
  })

  test('an unrelated bundled skill still generates its prompt', async () => {
    registerSimplifySkill()
    const skill = getBundledSkills().find(command => command.name === 'simplify')
    if (skill?.type !== 'prompt') throw new Error('Expected the bundled simplify prompt skill')

    const blocks = await skill.getPromptForCommand('review this fixture', {} as ToolUseContext)
    expect(blocks).toEqual([{ type: 'text', text: expect.stringContaining('review this fixture') }])
  })

  test('prompt generation leaves runtime validation and unknown-field preservation unchanged', async () => {
    await invokeUpdateConfig('set DEBUG=true')

    const settings = { env: { DEBUG: 1 }, futureSetting: { keep: true } }
    expect(SettingsSchema().parse(settings)).toMatchObject({
      env: { DEBUG: '1' },
      futureSetting: { keep: true },
    })
    expect(SettingsSchema().safeParse({ enabledPlugins: { 'test@builtin': 123 } }).success).toBe(false)
    expect(SettingsSchema().safeParse({ cleanupPeriodDays: -1 }).success).toBe(false)
    expect(validateSettingsFileContent(JSON.stringify({ enabledPlugins: { 'test@builtin': true } })).isValid).toBe(true)
    expect(validateSettingsFileContent(JSON.stringify({ enabledPlugins: { 'test@builtin': 123 } })).isValid).toBe(false)
    expect(validateSettingsFileContent(JSON.stringify({ futureSetting: true })).isValid).toBe(false)
  })
})
