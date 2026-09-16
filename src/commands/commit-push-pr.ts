import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import { getDefaultBranch } from '../utils/git.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import {
  resolveDefaultShell,
  type ShellToolType,
} from '../utils/shell/resolveDefaultShell.js'
import { getUndercoverInstructions, isUndercover } from '../utils/undercover.js'

const ALLOWED_COMMANDS = [
  'git checkout --branch:*',
  'git checkout -b:*',
  'git add:*',
  'git status:*',
  'git push:*',
  'git commit:*',
  'gh pr create:*',
  'gh pr edit:*',
  'gh pr view:*',
  'gh pr merge:*',
]

const NON_SHELL_ALLOWED_TOOLS = [
  'ToolSearch',
  'mcp__slack__send_message',
  'mcp__claude_ai_Slack__slack_send_message',
]

export function getCommitPushPrAllowedTools(
  shell: ShellToolType | null,
): string[] {
  if (!shell) return [...NON_SHELL_ALLOWED_TOOLS]
  const toolName = shell === 'powershell' ? 'PowerShell' : 'Bash'
  return [
    ...ALLOWED_COMMANDS.map(command => `${toolName}(${command})`),
    ...NON_SHELL_ALLOWED_TOOLS,
  ]
}

export function getPromptContent(
  defaultBranch: string,
  shell: ShellToolType,
): string {
  const safeUser = process.env.SAFEUSER || ''
  const username = process.env.USER || ''

  let prefix = ''
  let reviewerArg = ' and `--reviewer anthropics/claude-code`'
  let addReviewerArg = ' (and add `--add-reviewer anthropics/claude-code`)'
  let changelogSection = `

## Changelog
<!-- CHANGELOG:START -->
[If this PR contains user-facing changes, add a changelog entry here. Otherwise, remove this section.]
<!-- CHANGELOG:END -->`
  let slackStep = `

5. After creating/updating the PR, check if the user's CLAUDE.md mentions posting to Slack channels. If it does, use ToolSearch to search for "slack send message" tools. If ToolSearch finds a Slack tool, ask the user if they'd like you to post the PR URL to the relevant Slack channel. Only post if the user confirms. If ToolSearch returns no results or errors, skip this step silently—do not mention the failure, do not attempt workarounds, and do not try alternative approaches.`
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    prefix = getUndercoverInstructions() + '\n'
    reviewerArg = ''
    addReviewerArg = ''
    changelogSection = ''
    slackStep = ''
  }

  const prViewCommand =
    shell === 'powershell'
      ? 'gh pr view --json number 2>$null; if ($LASTEXITCODE -ne 0) { exit 0 }'
      : 'gh pr view --json number 2>/dev/null || true'
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
  const prExample =
    shell === 'powershell'
      ? `$prBody = @'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]${changelogSection}
'@
gh pr create --title "Short, descriptive title" --body $prBody`
      : `gh pr create --title "Short, descriptive title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]${changelogSection}
EOF
)"`

  return `${prefix}## Context

- \`SAFEUSER\`: ${safeUser}
- \`whoami\`: ${username}
- \`git status\`: !\`git status\`
- \`git diff HEAD\`: !\`git diff HEAD\`
- \`git branch --show-current\`: !\`git branch --show-current\`
- \`git diff ${defaultBranch}...HEAD\`: !\`git diff ${defaultBranch}...HEAD\`
- \`${prViewCommand}\`: !\`${prViewCommand}\`

## Git Safety Protocol

- NEVER update the git config
- NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- Do not commit files that likely contain secrets (.env, credentials.json, etc)
- Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported

## Your task

Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request from the git diff ${defaultBranch}...HEAD output above).

Based on the above changes:
1. Create a new branch if on ${defaultBranch} (use SAFEUSER from context above for the branch name prefix, falling back to whoami if SAFEUSER is empty, e.g., \`username/feature-name\`)
2. Create a single commit with an appropriate message using ${shell === 'powershell' ? 'a PowerShell here-string' : 'heredoc syntax'}:
\`\`\`
${commitExample}
\`\`\`
3. Push the branch to origin
4. If a PR already exists for this branch (check the gh pr view output above), update the PR title and body using \`gh pr edit\` to reflect the current diff${addReviewerArg}. Otherwise, create a pull request using \`gh pr create\` with ${shell === 'powershell' ? 'a PowerShell here-string' : 'heredoc syntax'} for the body${reviewerArg}.
   - IMPORTANT: Keep PR titles short (under 70 characters). Use the body for details.
\`\`\`
${prExample}
\`\`\`

You have the capability to call multiple tools in a single response. You MUST do all of the above in a single message.${slackStep}

Return the PR URL when you're done, so the user can see it.`
}

export async function buildCommitPushPrPrompt(
  args: string,
  context: ToolUseContext,
  dependencies: {
    resolveShell?: typeof resolveDefaultShell
    execute?: typeof executeShellCommandsInPrompt
    getBranch?: typeof getDefaultBranch
  } = {},
) {
  const shell = (dependencies.resolveShell ?? resolveDefaultShell)()
  if (!shell) {
    throw new Error(
      'No supported command shell is available. Install Git Bash or enable PowerShell.',
    )
  }
  const allowedTools = getCommitPushPrAllowedTools(shell)
  const defaultBranch = await (dependencies.getBranch ?? getDefaultBranch)()
  let promptContent = getPromptContent(defaultBranch, shell)

  const trimmedArgs = args?.trim()
  if (trimmedArgs) {
    promptContent += `\n\n## Additional instructions from user\n\n${trimmedArgs}`
  }

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
    '/commit-push-pr',
    shell,
  )

  return [{ type: 'text' as const, text: finalContent }]
}

const command = {
  type: 'prompt',
  name: 'commit-push-pr',
  description: 'Commit, push, and open a PR',
  get allowedTools() {
    return getCommitPushPrAllowedTools(resolveDefaultShell())
  },
  get contentLength() {
    // Use 'main' as estimate for content length calculation
    return getPromptContent('main', resolveDefaultShell() ?? 'bash').length
  },
  progressMessage: 'creating commit and PR',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    return buildCommitPushPrPrompt(args, context)
  },
} satisfies Command

export default command
