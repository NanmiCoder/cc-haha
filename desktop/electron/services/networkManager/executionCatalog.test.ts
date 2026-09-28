// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getNetworkExecutionCatalog, networkScriptBranch } from './executionCatalog'
import { NETWORK_SCRIPT } from './powershell'

describe('compiled network execution reference', () => {
  it('extracts actual action branches without neighbouring actions', () => {
    const script = networkScriptBranch('routeAdd')
    expect(script).toContain('New-NetRoute -DestinationPrefix $p.prefix')
    expect(NETWORK_SCRIPT).toContain(script)
    expect(script).not.toContain("'routeRemove'")
    expect(networkScriptBranch('split')).toContain('function VpnArgs')
    expect(networkScriptBranch('proxyDiscover')).toContain('function Get-SakuraProcesses')
  })
  it('lists every native branch plus relevant non-script functions', () => {
    const catalog = getNetworkExecutionCatalog()
    for (const match of NETWORK_SCRIPT.matchAll(/^  '([^']+)' \{/gm)) expect(catalog.actions.some(action => action.id === match[1])).toBe(true)
    expect(catalog.actions.find(action => action.id === 'probeHost')?.functionName).toContain('resolveHost')
    expect(catalog.actions.find(action => action.id === 'proxy-bypass')?.script).toContain('[REDACTED]')
    expect(catalog.actions.find(action => action.id === 'vpnBinding')?.functionName).toContain('activateBinding')
    expect(new Set(catalog.actions.map(action => action.id)).size).toBe(catalog.actions.length)
    expect(() => networkScriptBranch('arbitrary')).toThrow('UNKNOWN_NETWORK_SCRIPT_ACTION')
  })
})
