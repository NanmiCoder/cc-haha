/**
 * Test-only preload. Replace native installation/enumeration, never the CLI's
 * configuration, MCP client, tool assembly, permission rules or turn lifecycle.
 */
import { mock } from 'bun:test'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildPlatformComputerUseTools } from '../../../src/vendor/computer-use-mcp/mcpServer'

const configDir = process.env.CLAUDE_CONFIG_DIR
const log = process.env.MOCK_COMPUTER_USE_FIXTURE_LOG
if (!configDir || !log || isAbsolute(relative(configDir, log)) || relative(configDir, log).startsWith('..')) {
  throw new Error('Computer Use native fixture requires an isolated config directory and log')
}
const bridgePath = import.meta.resolve('../../../src/utils/computerUse/cuHelperBridge.ts')
const bridge = await import(bridgePath)
mock.module(bridgePath, () => ({
  ...bridge,
  resolveLaunchableCuHelperBinary: () => process.env.MOCK_COMPUTER_USE_HELPER_UNAVAILABLE === '1'
    ? null
    : '/mock-computer-use/no-native-binary',
  callCuHelper: () => {
    throw new Error('Native Computer Use must never execute in the mock lane')
  },
}))
mock.module(import.meta.resolve('../../../src/utils/computerUse/mcpServer.ts'), () => ({
  async createComputerUseMcpServerForCli() {
    appendFileSync(log, JSON.stringify({ event: 'connect', pid: process.pid }) + '\n')
    const server = new Server({ name: 'computer-use-native-fixture', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const config = JSON.parse(readFileSync(join(configDir, 'cc-haha', 'computer-use-config.json'), 'utf8'))
      return {
        tools: config.enabled
          ? buildPlatformComputerUseTools({
              platform: process.platform === 'win32' ? 'win32' : 'darwin',
              screenshotFiltering: 'none',
            }, 'pixels')
          : [],
      }
    })
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new Error('The inventory-only fixture must never dispatch Computer Use')
    })
    return server
  },
}))
