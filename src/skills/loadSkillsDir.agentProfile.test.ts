import { afterEach, expect, spyOn, test } from 'bun:test'
import { createSkillCommand } from './loadSkillsDir.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../Tool.js'
import { setAgentProfile } from '../utils/agentProfile.js'
import * as shell from '../utils/promptShellExecution.js'

afterEach(() => setAgentProfile('standard'))

test('lean skill shell interpolation retains original permissions, standard uses skill allowlist', async () => {
  const captured: unknown[] = []
  const execution = spyOn(shell, 'executeShellCommandsInPrompt').mockImplementation(async (text, context) => {
    captured.push(context.getAppState().toolPermissionContext.alwaysAllowRules.command)
    return text
  })
  try {
    const skill = createSkillCommand({
      skillName: 'fixture', displayName: undefined, description: 'fixture', hasUserSpecifiedDescription: true,
      markdownContent: '!`fixture`', allowedTools: ['Bash(*)'], argumentHint: undefined, argumentNames: [],
      whenToUse: undefined, version: undefined, model: undefined, disableModelInvocation: false,
      userInvocable: true, source: 'projectSettings', baseDir: undefined, loadedFrom: 'skills',
      hooks: undefined, executionContext: undefined, agent: undefined, paths: undefined, effort: undefined, shell: undefined,
    })
    if (skill.type !== 'prompt') throw new Error('expected prompt')
    const permissions = getEmptyToolPermissionContext()
    permissions.alwaysAllowRules.command = ['Read']
    const context = { getAppState: () => ({ toolPermissionContext: permissions }) } as ToolUseContext
    setAgentProfile('lean')
    await skill.getPromptForCommand('', context)
    setAgentProfile('standard')
    await skill.getPromptForCommand('', context)
    expect(captured).toEqual([['Read'], ['Bash(*)']])
    expect(permissions.alwaysAllowRules.command).toEqual(['Read'])
  } finally { execution.mockRestore() }
})
