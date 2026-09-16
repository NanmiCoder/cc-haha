import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import {
  resolveDefaultShell,
  type ShellToolType,
} from '../utils/shell/resolveDefaultShell.js'
import { getUndercoverInstructions, isUndercover } from '../utils/undercover.js'

const ALLOWED_COMMANDS = [
  'git add:*',
  'git status:*',
  'git commit:*',
]

export function getCommitAllowedTools(shell: ShellToolType | null): string[] {
  if (!shell) return []
  const toolName = shell === 'powershell' ? 'PowerShell' : 'Bash'
  return ALLOWED_COMMANDS.map(command => `${toolName}(${command})`)
}

export function getPromptContent(shell: ShellToolType): string {
  let prefix = ''
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    prefix = getUndercoverInstructions() + '\n'
  }

  const commitExample =
    shell === 'powershell'
      ? `$commitMessage = @'
Commit message here.
'@
git commit -m $commitMessage`
      : `git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"`

  return `${prefix}## Context

- Current git status: !\`git status\`
- Current git diff (staged and unstaged changes): !\`git diff HEAD\`
- Current branch: !\`git branch --show-current\`
- Recent commits: !\`git log --oneline -10\`

## Git Safety Protocol

- NEVER update the git config
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- CRITICAL: ALWAYS create NEW commits. NEVER use git commit --amend, unless the user explicitly requests it
- Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported

## Your task

Based on the above changes, create a single git commit:

1. Analyze all staged changes and draft a commit message:
   - Look at the recent commits above to follow this repository's commit message style
   - Summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs, etc.)
   - Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.)
   - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"

2. Stage relevant files and create the commit using ${shell === 'powershell' ? 'a PowerShell here-string' : 'HEREDOC syntax'}:
\`\`\`
${commitExample}
\`\`\`

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.`
}

export async function buildCommitPrompt(
  context: ToolUseContext,
  dependencies: {
    resolveShell?: typeof resolveDefaultShell
    execute?: typeof executeShellCommandsInPrompt
  } = {},
) {
  const shell = (dependencies.resolveShell ?? resolveDefaultShell)()
  if (!shell) {
    throw new Error(
      'No supported command shell is available. Install Git Bash or enable PowerShell.',
    )
  }
  const allowedTools = getCommitAllowedTools(shell)
  const promptContent = getPromptContent(shell)
  const finalContent = await (
    dependencies.execute ?? executeShellCommandsInPrompt
  )(
    promptContent,
    {
      ...context,
      getAppState() {
        const appState = context.getAppState()
        return {
          ...appState,
          toolPermissionContext: {
            ...appState.toolPermissionContext,
            alwaysAllowRules: {
              ...appState.toolPermissionContext.alwaysAllowRules,
              command: allowedTools,
            },
          },
        }
      },
    },
    '/commit',
    shell,
  )

  return [{ type: 'text' as const, text: finalContent }]
}

const command = {
  type: 'prompt',
  name: 'commit',
  description: 'Create a git commit',
  get allowedTools() {
    return getCommitAllowedTools(resolveDefaultShell())
  },
  contentLength: 0, // Dynamic content
  progressMessage: 'creating commit',
  source: 'builtin',
  async getPromptForCommand(_args, context) {
    return buildCommitPrompt(context)
  },
} satisfies Command

export default command
