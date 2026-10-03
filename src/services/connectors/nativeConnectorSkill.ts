import type { ConnectorDefinition, ConnectorId, ConnectorInstallation } from './types.js'

export const nativeConnectorRecipes: Record<ConnectorId, { name: string; help: string; task: string }> = {
  feishu: { name: '飞书 / Feishu', help: 'calendar --help', task: 'Read the user’s calendar agenda with calendar +agenda. Discover document commands with docs --help.' },
  dingtalk: { name: '钉钉 / DingTalk', help: 'calendar +agenda --help', task: 'For today’s agenda use calendar +agenda --format json. The account needs calendar access and any required organization approval. Discover other domains with --help before use.' },
  wecom: { name: '企业微信 / WeCom', help: 'calendar schedules list --help', task: 'List calendar schedules with calendar schedules list --begin-time <start> --end-time <end>, using the requested time window and this version’s documented time format. Omitted dates default to the next 30 days, not today. This command already returns JSON; do not append an unsupported --format flag. Discover other domains with --help before use.' },
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function powershellQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}


export function renderNativeConnectorSkill(definition: ConnectorDefinition, installation: ConnectorInstallation): string {
  const expectedName = `office-${definition.id}`
  if (definition.pluginId !== `${expectedName}@haha-connectors` || !nativeConnectorRecipes[definition.id]) {
    throw new Error('Invalid managed native connector identity')
  }
  const recipe = nativeConnectorRecipes[definition.id]!
  const command = [installation.command, ...installation.args]
  // Only adapter-owned non-secret environment entries belong in skill text.
  const environment = Object.entries(installation.env).filter(([key]) => ['DWS_CONFIG_DIR', 'DWS_KEYCHAIN_DIR', 'DWS_DISABLE_KEYCHAIN'].includes(key))
  const bashCommand = [...environment.map(([key, value]) => `${key}=${shellQuote(value)}`), ...command.map(shellQuote)].join(' ')
  const windowsCommand = `${environment.map(([key, value]) => `$env:${key} = ${powershellQuote(value)}; `).join('')}& ${command.map(powershellQuote).join(' ')}`
  return `---
name: ${expectedName}
description: Use ${recipe.name} through the desktop-managed connector when the user requests its documents, calendar, or collaboration services.
---

# ${recipe.name}

This skill belongs to the desktop connector. The desktop manages installation and account connection. Use the pinned executable below; do not install a global CLI, change accounts, or delete configuration directories.

## Invocation

On macOS / a POSIX shell:

\`\`\`sh
${bashCommand} ${recipe.help}
\`\`\`

On Windows PowerShell:

\`\`\`powershell
${windowsCommand} ${recipe.help}
\`\`\`

Keep the executable path, environment and prefix arguments when appending a command. Request JSON output where supported and inspect this version's --help instead of guessing parameters. ${recipe.task}

## Account and permissions

Use the connected account only. A successful login does not grant every business permission. If authentication expires or required scopes are missing, explain the service's error and direct the user to the desktop connector's connection flow. Do not print tokens, perform login from a task, or read credential files.

Prefer read-only discovery. Send messages, edit documents, create events, or perform other writes only when the user's request authorizes that action. Show errors accurately; never claim a business operation succeeded from login status alone.

Official documentation: ${definition.homepage}
Pinned package: ${definition.packageName}@${definition.version}
`
}
