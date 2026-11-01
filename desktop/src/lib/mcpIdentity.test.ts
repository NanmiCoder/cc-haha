import { describe, expect, it } from 'vitest'
import {
  dedupeMcpProjectPaths,
  getMcpServerIdentityKey,
  mcpProjectPathKey,
} from './mcpIdentity'

describe('MCP project identity', () => {
  it('treats Windows separator and casing variants as the same project', () => {
    expect(mcpProjectPathKey('C:\\UE\\StrangeAutumn')).toBe('c:/ue/strangeautumn')
    expect(mcpProjectPathKey('c:/ue/STRANGEAUTUMN/')).toBe('c:/ue/strangeautumn')
    expect(dedupeMcpProjectPaths([
      'C:\\UE\\StrangeAutumn',
      'C:/UE/StrangeAutumn',
    ])).toEqual(['C:\\UE\\StrangeAutumn'])
  })

  it('keeps case-distinct POSIX paths separate', () => {
    expect(dedupeMcpProjectPaths(['/workspace/Maya', '/workspace/maya'])).toEqual([
      '/workspace/Maya',
      '/workspace/maya',
    ])
  })

  it('keeps literal POSIX backslashes and trailing filename spaces distinct', () => {
    expect(dedupeMcpProjectPaths(['/workspace/a\\b', '/workspace/a/b', '/workspace/a ', '/workspace/a'])).toEqual([
      '/workspace/a\\b', '/workspace/a/b', '/workspace/a ', '/workspace/a',
    ])
    expect(mcpProjectPathKey('/workspace/a\\b')).toBe('/workspace/a\\b')
    expect(mcpProjectPathKey('/workspace/a ')).toBe('/workspace/a ')
  })

  it('includes the declaring project in local and project server identities', () => {
    expect(getMcpServerIdentityKey({
      name: 'shared',
      scope: 'project',
      projectPath: 'C:\\UE\\Project',
    })).toBe('project:c:/ue/project:shared')
    expect(getMcpServerIdentityKey({
      name: 'shared',
      scope: 'project',
      projectPath: 'C:/UE/Other',
    })).toBe('project:c:/ue/other:shared')
  })
})
