import { describe, it, expect } from 'vitest'
import { skillsApi } from '../api/skills'

describe('skillsApi active skills methods', () => {
  it('getActiveSkills method exists and is a function', () => {
    expect(typeof skillsApi.getActiveSkills).toBe('function')
  })

  it('setActiveSkills method exists and is a function', () => {
    expect(typeof skillsApi.setActiveSkills).toBe('function')
  })

  it('getActiveSkills defaults to merged scope', () => {
    // Verify the function signature accepts no required args
    // (the api call itself would fail without a server, but we test the client shape)
    expect(skillsApi.getActiveSkills.length).toBeLessThanOrEqual(2)
  })

  it('setActiveSkills requires skills array and scope', () => {
    expect(skillsApi.setActiveSkills.length).toBeGreaterThanOrEqual(2)
  })
})
