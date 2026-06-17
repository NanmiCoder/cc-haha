import { describe, it, expect } from 'bun:test'
import type { GlobalConfig, ProjectConfig } from '../config'

/**
 * Verify that the activeSkills field is correctly typed on both
 * GlobalConfig and ProjectConfig. This is a compile-time + runtime
 * shape test — the field is optional string[].
 */
describe('config activeSkills field', () => {
  it('GlobalConfig accepts activeSkills as string[]', () => {
    const config: Partial<GlobalConfig> = {
      activeSkills: ['karpathy-guidelines', 'react-best-practices'],
    }
    expect(config.activeSkills).toEqual(['karpathy-guidelines', 'react-best-practices'])
  })

  it('GlobalConfig accepts activeSkills as undefined', () => {
    const config: Partial<GlobalConfig> = {}
    expect(config.activeSkills).toBeUndefined()
  })

  it('ProjectConfig accepts activeSkills as string[]', () => {
    const config: Partial<ProjectConfig> = {
      activeSkills: ['stripe-best-practices'],
    }
    expect(config.activeSkills).toEqual(['stripe-best-practices'])
  })

  it('ProjectConfig accepts activeSkills as undefined', () => {
    const config: Partial<ProjectConfig> = {}
    expect(config.activeSkills).toBeUndefined()
  })
})
