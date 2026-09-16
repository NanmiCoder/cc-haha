import type { ConnectorDefinition } from './types.js'
import { SKILL_CONNECTORS } from './skillCatalog.js'
import { REMOTE_CONNECTORS } from './remoteCatalog.js'

// Native artifacts were inspected at these exact upstream versions. Windows ARM64
// is deliberately absent for WeCom: upstream does not publish that target.
export const CONNECTORS: ConnectorDefinition[] = [
  { id: 'feishu', pluginId: 'office-feishu@haha-connectors', packageName: '@larksuite/cli', version: '1.0.95', homepage: 'https://github.com/larksuite/cli', credentialMode: 'shared', platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'] },
  { id: 'dingtalk', pluginId: 'office-dingtalk@haha-connectors', packageName: 'dingtalk-workspace-cli', version: '1.0.61', homepage: 'https://gitee.com/DingTalk-Real-AI/dingtalk-workspace-cli', credentialMode: 'isolated', platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'] },
  { id: 'wecom', pluginId: 'office-wecom@haha-connectors', packageName: '@wecom/cli', version: '1.2.1', homepage: 'https://github.com/WecomTeam/wecom-cli', credentialMode: 'shared', platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64'] },
]

export const ALL_CONNECTORS: ConnectorDefinition[] = [...CONNECTORS, ...REMOTE_CONNECTORS, ...SKILL_CONNECTORS]

export function getConnectorDefinition(id: string): ConnectorDefinition | undefined {
  return ALL_CONNECTORS.find((definition) => definition.id === id)
}
