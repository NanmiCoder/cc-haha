import { describe, expect, mock, test } from 'bun:test'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import {
  buildCommitPrompt,
  getCommitAllowedTools,
  getPromptContent as getCommitPrompt,
} from './commit.js'
import {
  buildCommitPushPrPrompt,
  getCommitPushPrAllowedTools,
  getPromptContent as getCommitPushPrPrompt,
} from './commit-push-pr.js'
import {
  buildSecurityReviewPrompt,
  getSecurityReviewMarkdown,
} from './security-review.js'
import { getSimplePrompt } from '../tools/BashTool/prompt.js'

function createTool(name: string, stdout: string) {
  const call = mock(async () => ({
    data: { stdout, stderr: '', interrupted: false },
  }))
  return {
    call,
    tool: {
      name,
      call,
      maxResultSizeChars: 100_000,
      mapToolResultToToolResultBlockParam: () => ({
        type: 'tool_result' as const,
        tool_use_id: 'test',
        content: stdout,
      }),
    },
  }
}

const allow = async () => ({ behavior: 'allow' as const })
const processResult = async (
  _tool: unknown,
  data: { stdout: string },
) => ({
  type: 'tool_result' as const,
  tool_use_id: 'test',
  content: data.stdout,
})

const context = {
  getAppState: () => ({
    toolPermissionContext: {
      alwaysAllowRules: { command: [] },
    },
  }),
}

function createPromptExecutor(expectedCommandName: string) {
  return mock(
    async (
      _text: string,
      executionContext: typeof context,
      commandName: string,
      shell: string,
    ) => {
      expect(commandName).toBe(expectedCommandName)
      expect(shell).toBe('powershell')
      const allowed = executionContext.getAppState().toolPermissionContext
        .alwaysAllowRules.command
      expect(allowed.some(rule => rule.startsWith('PowerShell('))).toBe(true)
      expect(allowed.some(rule => rule.startsWith('Bash('))).toBe(false)
      return 'processed'
    },
  )
}

describe('built-in command shell prompts', () => {
  test('uses PowerShell permission rules and here-strings for commit', () => {
    expect(getCommitAllowedTools('powershell')).toEqual([
      'PowerShell(git add:*)',
      'PowerShell(git status:*)',
      'PowerShell(git commit:*)',
    ])

    const prompt = getCommitPrompt('powershell')
    expect(prompt).toContain("$commitMessage = @'")
    expect(prompt).toContain('git commit -m $commitMessage')
    expect(prompt).not.toContain("cat <<'EOF'")
  })

  test('keeps Bash syntax when Bash is selected', () => {
    const prompt = getCommitPrompt('bash')
    expect(prompt).toContain("cat <<'EOF'")
    expect(prompt).not.toContain("$commitMessage = @'")
  })

  test('uses PowerShell-safe probing and multiline arguments for commit-push-pr', () => {
    const tools = getCommitPushPrAllowedTools('powershell')
    expect(tools).toContain('PowerShell(gh pr view:*)')
    expect(tools).not.toContain('Bash(gh pr view:*)')

    const prompt = getCommitPushPrPrompt('main', 'powershell')
    expect(prompt).toContain('2>$null')
    expect(prompt).toContain("$prBody = @'")
    expect(prompt).not.toContain('/dev/null')
    expect(prompt).not.toContain("cat <<'EOF'")
  })

  test('keeps the Bash commit-push-pr prompt unchanged in shape', () => {
    const prompt = getCommitPushPrPrompt('main', 'bash')
    expect(prompt).toContain('2>/dev/null || true')
    expect(prompt).toContain("cat <<'EOF'")
    expect(prompt).not.toContain('2>$null')
  })

  test('uses PowerShell permissions for the security review command', () => {
    const markdown = getSecurityReviewMarkdown('powershell')
    expect(markdown).toContain('allowed-tools: PowerShell(git diff:*)')
    expect(markdown).not.toContain('allowed-tools: Bash(')
  })

  test('builds /commit with PowerShell execution and permissions', async () => {
    const execute = createPromptExecutor('/commit')
    const result = await buildCommitPrompt(context as never, {
      resolveShell: () => 'powershell',
      execute: execute as never,
    })

    expect(result).toEqual([{ type: 'text', text: 'processed' }])
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('builds /commit-push-pr without contacting GitHub', async () => {
    const execute = createPromptExecutor('/commit-push-pr')
    const result = await buildCommitPushPrPrompt(
      'keep the title short',
      context as never,
      {
        resolveShell: () => 'powershell',
        execute: execute as never,
        getBranch: async () => 'main',
      },
    )

    expect(result).toEqual([{ type: 'text', text: 'processed' }])
    expect(execute.mock.calls[0]?.[0]).toContain(
      '## Additional instructions from user\n\nkeep the title short',
    )
  })

  test('builds /security-review with PowerShell execution and permissions', async () => {
    const execute = createPromptExecutor('security-review')
    const result = await buildSecurityReviewPrompt(context as never, {
      resolveShell: () => 'powershell',
      execute: execute as never,
    })

    expect(result).toEqual([{ type: 'text', text: 'processed' }])
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('fails clearly when no shell is enabled', async () => {
    await expect(
      buildCommitPrompt(context as never, { resolveShell: () => null }),
    ).rejects.toThrow('No supported command shell is available')
    await expect(
      buildCommitPushPrPrompt('', context as never, {
        resolveShell: () => null,
      }),
    ).rejects.toThrow('No supported command shell is available')
    await expect(
      buildSecurityReviewPrompt(context as never, {
        resolveShell: () => null,
      }),
    ).rejects.toThrow('No supported command shell is available')
  })
})

describe('commit and PR prompts', () => {
  test('never inject Claude attribution into commit or PR instructions', () => {
    const previous = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
    process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = 'false'
    try {
      const bashPrompt = getSimplePrompt()
      // Non-vacuous: both the external and ant variants carry this line.
      expect(bashPrompt).toContain('NEVER skip hooks')

      const prompts = [
        bashPrompt,
        getCommitPrompt('bash'),
        getCommitPushPrPrompt('main', 'bash'),
      ]
      for (const prompt of prompts) {
        expect(prompt).not.toContain('Co-Authored-By')
        expect(prompt).not.toContain('Generated with Claude Code')
      }
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
      } else {
        process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = previous
      }
    }
  })
})

describe('embedded command shell routing', () => {
  test('executes PowerShell content without losing Unicode or tabs', async () => {
    const bash = createTool('Bash', 'bash-output')
    const powershell = createTool('PowerShell', '中文\tpowershell-output')

    const result = await executeShellCommandsInPrompt(
      'result: !`Write-Output 中文`',
      {} as never,
      '/windows-command',
      'powershell',
      {
        availability: { bash: false, powershell: true },
        bashTool: bash.tool as never,
        powerShellTool: powershell.tool as never,
        checkPermission: allow as never,
        processResult: processResult as never,
      },
    )

    expect(result).toBe('result: 中文\tpowershell-output')
    expect(powershell.call).toHaveBeenCalledTimes(1)
    expect(powershell.call.mock.calls[0]?.[0]).toEqual({
      command: 'Write-Output 中文',
    })
    expect(bash.call).not.toHaveBeenCalled()
  })

  test('keeps Bash content on Bash', async () => {
    const bash = createTool('Bash', 'bash-output')
    const powershell = createTool('PowerShell', 'powershell-output')

    const result = await executeShellCommandsInPrompt(
      'result: !`printf ok`',
      {} as never,
      '/bash-command',
      'bash',
      {
        availability: { bash: true, powershell: false },
        bashTool: bash.tool as never,
        powerShellTool: powershell.tool as never,
        checkPermission: allow as never,
        processResult: processResult as never,
      },
    )

    expect(result).toBe('result: bash-output')
    expect(bash.call).toHaveBeenCalledTimes(1)
    expect(powershell.call).not.toHaveBeenCalled()
  })

  test('reports an unavailable explicit shell instead of changing syntax', async () => {
    await expect(
      executeShellCommandsInPrompt(
        'result: !`printf ok`',
        {} as never,
        '/bash-command',
        'bash',
        { availability: { bash: false, powershell: true } },
      ),
    ).rejects.toThrow('Bash is required to execute commands in /bash-command')
  })
})
