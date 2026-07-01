#!/usr/bin/env bun
/**
 * Validates spark2-gamedev plugin structure and JSON files.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN_ROOT = join(import.meta.dir, '..')

function readJson(path: string) {
  const content = readFileSync(path, 'utf-8')
  return JSON.parse(content)
}

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`)
    process.exitCode = 1
  }
}

console.log('Validating spark2-gamedev plugin...\n')

// 1. plugin.json
console.log('[plugin.json]')
const pluginJsonPath = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
check('exists', existsSync(pluginJsonPath))
const pluginJson = readJson(pluginJsonPath)
check('has name', pluginJson.name === 'spark2-gamedev')
check('has version', typeof pluginJson.version === 'string')
check('has mcpServers', typeof pluginJson.mcpServers === 'string')
check('has userConfig', typeof pluginJson.userConfig === 'object')
check('userConfig.SCE_PROJECT_DIR', !!pluginJson.userConfig?.SCE_PROJECT_DIR)
check('userConfig.SCE_MCP_PORT', !!pluginJson.userConfig?.SCE_MCP_PORT)

// 2. servers.json
console.log('\n[mcp/servers.json]')
const serversJsonPath = join(PLUGIN_ROOT, 'mcp', 'servers.json')
check('exists', existsSync(serversJsonPath))
const serversJson = readJson(serversJsonPath)
check('has sce-editor-mcp entry', !!serversJson['sce-editor-mcp'])
check('command is node', serversJson['sce-editor-mcp']?.command === 'node')

// 3. bridge script
console.log('\n[mcp/sce-editor-bridge.mjs]')
const bridgePath = join(PLUGIN_ROOT, 'mcp', 'sce-editor-bridge.mjs')
check('exists', existsSync(bridgePath))

// 4. skills
console.log('\n[skills]')
const skills = [
  '3d-unit-game', 'canvas-2d-game', 'multiplayer-hybrid-sync',
  'ui-layout-api', 'server-authoritative-3d-physics', 'runtime-particle-builder',
  'wasicore-dev', 'data-editor', 'debug-tools', 'trigger-editor-mcp', 'client-only-debug',
]
for (const skill of skills) {
  const skillPath = join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md')
  const exists = existsSync(skillPath)
  check(`${skill}/SKILL.md exists`, exists)
  if (exists) {
    const content = readFileSync(skillPath, 'utf-8')
    const hasFrontmatter = content.startsWith('---')
    const hasWhenToUse = content.includes('whenToUse:')
    const hasAllowedTools = content.includes('allowedTools:')
    check(`${skill} has whenToUse`, hasWhenToUse)
    check(`${skill} has allowedTools`, hasAllowedTools)
  }
}

// 5. reference.md companions
console.log('\n[reference.md companions]')
const withRef = ['3d-unit-game', 'canvas-2d-game', 'ui-layout-api', 'wasicore-dev']
for (const skill of withRef) {
  check(`${skill}/reference.md exists`, existsSync(join(PLUGIN_ROOT, 'skills', skill, 'reference.md')))
}

// 6. agent
console.log('\n[agents]')
check('spark2-developer.md exists', existsSync(join(PLUGIN_ROOT, 'agents', 'spark2-developer.md')))

// 7. commands
console.log('\n[commands]')
check('debug.md exists', existsSync(join(PLUGIN_ROOT, 'commands', 'debug.md')))
check('data.md exists', existsSync(join(PLUGIN_ROOT, 'commands', 'data.md')))

console.log('\n' + (process.exitCode ? '❌ Validation failed' : '✅ All checks passed'))
