import { afterEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import {
  buildTeammateRuntimeCliFlags,
  resolveTeammateModel,
} from './spawnMultiAgent.js'

const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL
const originalOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
const originalTeammateDefaultModel = getGlobalConfig().teammateDefaultModel

afterEach(() => {
  if (originalSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
  }
  if (originalOpusModel === undefined) {
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  } else {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = originalOpusModel
  }
  saveGlobalConfig(current => ({
    ...current,
    teammateDefaultModel: originalTeammateDefaultModel,
  }))
})

describe('buildTeammateRuntimeCliFlags', () => {
  test('propagates definition effort with adaptive session thinking', () => {
    expect(
      buildTeammateRuntimeCliFlags({
        effort: 'xhigh',
        thinkingConfig: { type: 'adaptive' },
      }),
    ).toEqual(['--effort xhigh', '--thinking adaptive'])
  })

  test('propagates disabled session thinking and numeric effort', () => {
    expect(
      buildTeammateRuntimeCliFlags({
        effort: 7,
        thinkingConfig: { type: 'disabled' },
      }),
    ).toEqual(['--effort 7', '--thinking disabled'])
  })

  test('uses only the budget flag for manual thinking', () => {
    expect(
      buildTeammateRuntimeCliFlags({
        thinkingConfig: { type: 'enabled', budgetTokens: 4096 },
      }),
    ).toEqual(['--max-thinking-tokens 4096'])
  })

  test('applies the global subagent model override to teammates', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'gpt-5.6-sol'
    expect(resolveTeammateModel('haiku', 'claude-sonnet-4-6', 'opus')).toBe(
      'gpt-5.6-sol',
    )
  })

  test('uses a concrete selected Agent model when invocation omits model', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL

    expect(
      resolveTeammateModel(undefined, 'claude-sonnet-4-6', 'gpt-5.6-luna'),
    ).toBe('gpt-5.6-luna')
  })

  test('an invocation inherit explicitly follows the leader', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL

    expect(
      resolveTeammateModel('inherit', 'claude-sonnet-4-6', 'gpt-5.6-luna'),
    ).toBe('claude-sonnet-4-6')
  })

  test('keeps an explicit invocation model above the selected agent model', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL

    expect(
      resolveTeammateModel('haiku', 'claude-sonnet-4-6', 'gpt-5.6-luna'),
    ).toBe(parseUserSpecifiedModel('haiku'))
  })

  test('treats a global inherit override as normal teammate resolution', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'
    saveGlobalConfig(current => ({
      ...current,
      teammateDefaultModel: null,
    }))
    expect(resolveTeammateModel('haiku', 'claude-sonnet-4-6')).toBe(
      parseUserSpecifiedModel('haiku'),
    )
    expect(resolveTeammateModel(undefined, 'claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6',
    )
    expect(resolveTeammateModel('inherit', 'claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6',
    )
    expect(
      resolveTeammateModel('inherit', 'claude-sonnet-4-6', 'inherit'),
    ).toBe('claude-sonnet-4-6')
  })

  test('uses teammateDefaultModel when no Agent definition is selected', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    saveGlobalConfig(current => ({
      ...current,
      teammateDefaultModel: 'gpt-5.6-luna',
    }))

    expect(
      resolveTeammateModel(
        undefined,
        'claude-sonnet-4-6',
        undefined,
        false,
      ),
    ).toBe('gpt-5.6-luna')
  })

  test('unset teammateDefaultModel follows the leader instead of a hardcoded Opus ID', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    saveGlobalConfig(current => {
      const next = { ...current }
      delete next.teammateDefaultModel
      return next
    })

    expect(
      resolveTeammateModel(
        undefined,
        'deepseek-flash',
        undefined,
        false,
      ),
    ).toBe('deepseek-flash')
  })

  test('an Agent page opus pin resolves through the provider mapping', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-flash'
    saveGlobalConfig(current => {
      const next = { ...current }
      delete next.teammateDefaultModel
      return next
    })

    expect(
      resolveTeammateModel(undefined, 'deepseek-flash', 'opus', true),
    ).toBe('deepseek-flash')
    expect(
      resolveTeammateModel(undefined, 'deepseek-flash', 'inherit', true),
    ).toBe('deepseek-flash')
  })

  test('selected Agents inherit the leader when model is omitted or inherit', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    saveGlobalConfig(current => ({
      ...current,
      teammateDefaultModel: 'gpt-5.6-luna',
    }))

    expect(
      resolveTeammateModel(
        undefined,
        'claude-sonnet-4-6',
        undefined,
        true,
      ),
    ).toBe('claude-sonnet-4-6')
    expect(
      resolveTeammateModel(
        undefined,
        'claude-sonnet-4-6',
        ' inherit ',
        true,
      ),
    ).toBe('claude-sonnet-4-6')
  })
})
