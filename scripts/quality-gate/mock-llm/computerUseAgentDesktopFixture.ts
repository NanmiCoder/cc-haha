/** Test-only platform selection; the real CLI, MCP server and native bridge stay intact. */
import { isAbsolute, relative } from 'node:path'

const config = process.env.CLAUDE_CONFIG_DIR
const log = process.env.MOCK_AGENT_DESKTOP_LOG
const platform = process.env.MOCK_AGENT_DESKTOP_PLATFORM
if (!config || !log || isAbsolute(relative(config, log)) || relative(config, log).startsWith('..')) {
  throw new Error('Native desktop fixture requires a private config directory and log')
}
if (platform !== 'linux' && platform !== 'win32') throw new Error('Native desktop fixture needs an explicit supported platform')
Object.defineProperty(process, 'platform', { value: platform })
