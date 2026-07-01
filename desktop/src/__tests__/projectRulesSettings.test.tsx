import { describe, it, expect } from 'vitest'
import { ProjectRulesSettings } from '../pages/ProjectRulesSettings'

describe('ProjectRulesSettings', () => {
  it('exports ProjectRulesSettings component', () => {
    expect(typeof ProjectRulesSettings).toBe('function')
  })
})
