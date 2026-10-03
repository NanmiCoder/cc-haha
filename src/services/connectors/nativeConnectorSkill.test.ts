import { describe, expect, test } from 'bun:test'
import { renderNativeConnectorSkill } from './nativeConnectorSkill.js'
import type { ConnectorDefinition } from './types.js'

const definition: ConnectorDefinition = {
  id: 'dingtalk', pluginId: 'office-dingtalk@haha-connectors', packageName: 'dingtalk-workspace-cli',
  version: '1.0.50', homepage: 'https://example.test/official', credentialMode: 'isolated', platforms: ['win32-x64'],
}

describe('native connector skill regeneration', () => {
  test('renders relocated invocation commands safely and includes only owned environment entries', () => {
    const skill = renderNativeConnectorSkill(definition, {
      directory: "D:/Haha's data/connectors/runtime/dingtalk/1.0.50-win32-x64",
      command: "D:/Haha's data/connectors/runtime/dingtalk/1.0.50-win32-x64/dws.exe",
      args: ['--fixture'],
      env: { DWS_CONFIG_DIR: "D:/Haha's data/connectors/accounts/dingtalk/dws", DWS_DISABLE_KEYCHAIN: '1', SECRET: 'never-render' },
    })
    expect(skill).toContain('D:/Haha\'\'s data/connectors')
    expect(skill).toContain('D:/Haha\'"\'"\'s data/connectors')
    expect(skill).toContain('dingtalk-workspace-cli@1.0.50')
    expect(skill).not.toContain('never-render')
    expect(skill).not.toContain('SECRET')
  })

  test('rejects unknown native identities instead of regenerating a user plugin', () => {
    expect(() => renderNativeConnectorSkill({ ...definition, pluginId: 'user-plugin@market' }, { directory: '', command: '', args: [], env: {} }))
      .toThrow('Invalid managed native connector identity')
  })
})
