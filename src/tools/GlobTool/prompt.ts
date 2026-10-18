import { getAgentProfile } from '../../utils/agentProfile.js'

export const GLOB_TOOL_NAME = 'Glob'

const CORE_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns`

export const DESCRIPTION = `${CORE_DESCRIPTION}
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`

export function getDescription(): string {
  return getAgentProfile() === 'lean' ? CORE_DESCRIPTION : DESCRIPTION
}
