import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { join } from 'node:path'

// Mock config module
const mockGlobalConfig = { activeSkills: undefined as string[] | undefined }
const mockProjectConfig = { activeSkills: undefined as string[] | undefined }

const MOCK_HOME = '/mock/home/.claude'

mock.module('../../utils/config.js', () => ({
  getGlobalConfig: () => mockGlobalConfig,
  getCurrentProjectConfig: () => mockProjectConfig,
}))

mock.module('../../utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: () => MOCK_HOME,
}))

const mockFiles: Record<string, string> = {}
mock.module('../../utils/fsOperations.js', () => ({
  getFsImplementation: () => ({
    readFile: async (path: string) => {
      const content = mockFiles[path]
      if (!content) {
        const err = new Error(`ENOENT: no such file: ${path}`) as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    },
  }),
}))

mock.module('../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))

import { getActiveSkillNames, buildActiveSkillsPrompt } from '../activeSkills'

/** Build the expected path for a skill's SKILL.md */
function skillPath(name: string): string {
  return join(MOCK_HOME, 'skills', name, 'SKILL.md')
}

describe('activeSkills', () => {
  beforeEach(() => {
    mockGlobalConfig.activeSkills = undefined
    mockProjectConfig.activeSkills = undefined
    Object.keys(mockFiles).forEach(k => delete mockFiles[k])
  })

  describe('getActiveSkillNames', () => {
    it('returns empty array when no active skills configured', () => {
      expect(getActiveSkillNames()).toEqual([])
    })

    it('returns global active skills', () => {
      mockGlobalConfig.activeSkills = ['karpathy-guidelines', 'react-best-practices']
      expect(getActiveSkillNames()).toEqual(['karpathy-guidelines', 'react-best-practices'])
    })

    it('returns project active skills', () => {
      mockProjectConfig.activeSkills = ['stripe-best-practices']
      expect(getActiveSkillNames()).toEqual(['stripe-best-practices'])
    })

    it('deduplicates when same skill in both global and project', () => {
      mockGlobalConfig.activeSkills = ['karpathy-guidelines', 'react-best-practices']
      mockProjectConfig.activeSkills = ['karpathy-guidelines', 'stripe-best-practices']
      const result = getActiveSkillNames()
      // Project takes precedence (appears first), duplicates removed
      expect(result).toEqual(['karpathy-guidelines', 'stripe-best-practices', 'react-best-practices'])
    })

    it('project skills appear before global skills', () => {
      mockGlobalConfig.activeSkills = ['a-skill']
      mockProjectConfig.activeSkills = ['b-skill']
      expect(getActiveSkillNames()).toEqual(['b-skill', 'a-skill'])
    })
  })

  describe('buildActiveSkillsPrompt', () => {
    it('returns null when no active skills', async () => {
      const result = await buildActiveSkillsPrompt()
      expect(result).toBeNull()
    })

    it('returns null when active skills are configured but files not found', async () => {
      mockGlobalConfig.activeSkills = ['nonexistent-skill']
      const result = await buildActiveSkillsPrompt()
      expect(result).toBeNull()
    })

    it('builds prompt with single active skill content', async () => {
      mockGlobalConfig.activeSkills = ['karpathy-guidelines']
      mockFiles[skillPath('karpathy-guidelines')] =
        '---\nname: karpathy-guidelines\n---\n\n# Karpathy Guidelines\n\nBe simple.'

      const result = await buildActiveSkillsPrompt()
      expect(result).not.toBeNull()
      expect(result).toContain('# Active Skills')
      expect(result).toContain('# Karpathy Guidelines')
      expect(result).toContain('Be simple.')
    })

    it('builds prompt with multiple active skills', async () => {
      mockGlobalConfig.activeSkills = ['skill-a', 'skill-b']
      mockFiles[skillPath('skill-a')] = '# Skill A\n\nContent A'
      mockFiles[skillPath('skill-b')] = '# Skill B\n\nContent B'

      const result = await buildActiveSkillsPrompt()
      expect(result).not.toBeNull()
      expect(result).toContain('# Active Skills')
      expect(result).toContain('# Skill A')
      expect(result).toContain('Content A')
      expect(result).toContain('# Skill B')
      expect(result).toContain('Content B')
    })

    it('skips unreadable skills and includes readable ones', async () => {
      mockGlobalConfig.activeSkills = ['good-skill', 'missing-skill']
      mockFiles[skillPath('good-skill')] = '# Good\n\nWorks'

      const result = await buildActiveSkillsPrompt()
      expect(result).not.toBeNull()
      expect(result).toContain('# Good')
      expect(result).not.toContain('missing-skill')
    })
  })
})
