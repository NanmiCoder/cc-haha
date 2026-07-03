import { describe, expect, it } from 'bun:test'
import { normalizeClawHubList, normalizeClawHubScan } from '../services/skillMarket/clawhubAdapter.js'
import { createSkillMarketService } from '../services/skillMarket/service.js'
import { normalizeSkillHubDetail, normalizeSkillHubList } from '../services/skillMarket/skillhubAdapter.js'
import {
  CLAWHUB_SCAN_RESPONSE,
  CLAWHUB_TOP_SKILLS_RESPONSE,
  SKILLHUB_DETAIL_RESPONSE,
  SKILLHUB_TOP_SKILLS_RESPONSE,
} from './fixtures/skill-market.js'

describe('skill market fixtures', () => {
  it('keeps representative ClawHub fixture shape stable', () => {
    expect(CLAWHUB_TOP_SKILLS_RESPONSE.items[0]).toMatchObject({
      slug: 'skill-vetter',
      displayName: 'Skill Vetter',
      stats: expect.objectContaining({ downloads: expect.any(Number) }),
    })
  })

  it('keeps representative SkillHub fixture shape stable', () => {
    expect(SKILLHUB_TOP_SKILLS_RESPONSE.data.skills[0]).toMatchObject({
      slug: 'skill-vetter',
      source: 'clawhub',
      labels: expect.objectContaining({ requires_api_key: 'false' }),
    })
  })
})

describe('skill market source normalization', () => {
  it('normalizes ClawHub catalog items as primary clean candidates', () => {
    const result = normalizeClawHubList(CLAWHUB_TOP_SKILLS_RESPONSE)

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      source: 'clawhub',
      sourceMode: 'primary',
      slug: 'skill-vetter',
      displayName: 'Skill Vetter',
      canonicalUrl: 'https://clawhub.ai/skill-vetter',
      trustState: 'clean',
      installed: false,
      requiresApiKey: false,
    })
  })

  it('normalizes ClawHub scan responses into trust metadata', () => {
    expect(normalizeClawHubScan(CLAWHUB_SCAN_RESPONSE)).toEqual({
      trustState: 'clean',
      trustSummary: 'No dangerous patterns detected.',
      packageSha256: 'a'.repeat(64),
    })
  })

  it('keeps malicious ClawHub scan responses blocked even with warnings', () => {
    expect(normalizeClawHubScan({ status: 'malicious', hasWarnings: true })).toMatchObject({
      trustState: 'blocked',
    })
  })

  it('uses malicious ClawHub scanner summaries for malicious scans', () => {
    expect(normalizeClawHubScan({
      status: 'malicious',
      scanners: {
        metadata: { status: 'clean', summary: 'No dangerous patterns detected.' },
        staticAnalysis: { status: 'malicious', summary: 'Credential exfiltration detected.' },
      },
    })).toMatchObject({
      trustState: 'blocked',
      trustSummary: 'Credential exfiltration detected.',
    })
  })

  it('prioritizes malicious ClawHub scanner results over clean top-level status', () => {
    expect(normalizeClawHubScan({
      status: 'clean',
      scanners: {
        metadata: { status: 'clean', summary: 'No dangerous patterns detected.' },
        staticAnalysis: { status: 'malicious', summary: 'Credential exfiltration detected.' },
      },
    })).toMatchObject({
      trustState: 'blocked',
      trustSummary: 'Credential exfiltration detected.',
    })
  })

  it('does not use clean ClawHub scanner summaries for blocked scans', () => {
    expect(normalizeClawHubScan({
      status: 'malicious',
      scanners: {
        metadata: { status: 'clean', summary: 'No dangerous patterns detected.' },
      },
    })).toEqual({
      trustState: 'blocked',
      trustSummary: undefined,
      packageSha256: undefined,
    })
  })

  it('does not use clean ClawHub scanner summaries for warning scans', () => {
    expect(normalizeClawHubScan({
      status: 'suspicious',
      scanners: {
        metadata: { status: 'clean', summary: 'No dangerous patterns detected.' },
      },
    })).toEqual({
      trustState: 'warning',
      trustSummary: undefined,
      packageSha256: undefined,
    })
  })

  it('prioritizes warning ClawHub scanner results over clean top-level status', () => {
    expect(normalizeClawHubScan({
      status: 'clean',
      scanners: {
        metadata: { status: 'clean', summary: 'No dangerous patterns detected.' },
        staticAnalysis: { status: 'warning', summary: 'Reads shell profile files.' },
      },
    })).toMatchObject({
      trustState: 'warning',
      trustSummary: 'Reads shell profile files.',
    })
  })

  it('maps ClawHub top-level warning status to warning trust state', () => {
    expect(normalizeClawHubScan({
      status: 'warning',
      scanners: {
        staticAnalysis: { status: 'warning', summary: 'Reads shell profile files.' },
      },
    })).toMatchObject({
      trustState: 'warning',
      trustSummary: 'Reads shell profile files.',
    })
  })

  it('does not use clean ClawHub scanner summaries for unknown scans', () => {
    expect(normalizeClawHubScan({
      status: 'unknown',
      scanners: {
        metadata: { status: 'clean', summary: 'No dangerous patterns detected.' },
      },
    })).toEqual({
      trustState: 'unknown',
      trustSummary: undefined,
      packageSha256: undefined,
    })
  })

  it('does not use unscored ClawHub scanner summaries for unknown scans', () => {
    expect(normalizeClawHubScan({
      status: 'unknown',
      scanners: {
        metadata: { summary: 'No dangerous patterns detected.' },
      },
    })).toEqual({
      trustState: 'unknown',
      trustSummary: undefined,
      packageSha256: undefined,
    })
  })

  it('normalizes SkillHub list items as fallback candidates with Chinese summary', () => {
    const result = normalizeSkillHubList(SKILLHUB_TOP_SKILLS_RESPONSE)

    expect(result.items[0]).toMatchObject({
      source: 'skillhub',
      sourceMode: 'fallback',
      slug: 'skill-vetter',
      summaryZh: 'AI智能体技能安全预审工具。',
      canonicalUrl: 'https://clawhub.ai/spclaudehome/skill-vetter',
      license: 'Apache-2.0',
      tags: ['GitHub', 'Permission'],
      trustState: 'unknown',
      requiresApiKey: false,
    })
  })

  it('normalizes verified SkillHub list items as signed', () => {
    const result = normalizeSkillHubList({
      code: 0,
      data: {
        skills: [
          {
            slug: 'verified-skill',
            name: 'Verified Skill',
            upstream_url: 'https://github.com/example/verified-skill',
            verified: true,
          },
        ],
      },
    })

    expect(result.items[0]).toMatchObject({
      slug: 'verified-skill',
      canonicalUrl: 'https://github.com/example/verified-skill',
      upstreamUrl: 'https://github.com/example/verified-skill',
      trustState: 'signed',
    })
  })

  it('falls back when SkillHub external URLs are invalid', () => {
    const list = normalizeSkillHubList({
      code: 0,
      data: {
        skills: [
          {
            slug: 'unsafe/slug',
            name: 'Unsafe URL Skill',
            upstream_url: 'http://evil.test/unsafe/slug',
          },
        ],
      },
    })

    expect(list.items[0]).toMatchObject({
      canonicalUrl: 'https://skillhub.cn/skills/unsafe%2Fslug',
      upstreamUrl: 'https://skillhub.cn/skills/unsafe%2Fslug',
    })

    const detail = normalizeSkillHubDetail({
      securityReports: {
        keen: { status: 'benign', statusText: 'safe' },
      },
      skill: {
        slug: 'unsafe/slug',
        displayName: 'Unsafe URL Skill',
        sourceUrl: 'https://evil.test/unsafe/slug',
      },
    })

    expect(detail).toMatchObject({
      canonicalUrl: 'https://skillhub.cn/skills/unsafe%2Fslug',
      trustState: 'benign',
    })
  })

  it('rejects SkillHub external URLs with userinfo', () => {
    const list = normalizeSkillHubList({
      code: 0,
      data: {
        skills: [
          {
            slug: 'skill-vetter',
            name: 'Skill Vetter',
            upstream_url: 'https://evil.test@github.com/path',
          },
        ],
      },
    })

    expect(list.items[0]).toMatchObject({
      canonicalUrl: 'https://skillhub.cn/skills/skill-vetter',
      upstreamUrl: 'https://skillhub.cn/skills/skill-vetter',
    })

    const detail = normalizeSkillHubDetail({
      skill: {
        slug: 'skill-vetter',
        displayName: 'Skill Vetter',
        sourceUrl: 'https://user:password@github.com/path',
      },
    })

    expect(detail).toMatchObject({
      canonicalUrl: 'https://skillhub.cn/skills/skill-vetter',
    })
  })

  it('normalizes SkillHub detail security reports', () => {
    const detail = normalizeSkillHubDetail(SKILLHUB_DETAIL_RESPONSE)

    expect(detail).toMatchObject({
      source: 'skillhub',
      sourceMode: 'fallback',
      slug: 'skill-vetter',
      version: '1.0.1',
      license: 'Apache-2.0',
      tags: ['GitHub', 'Permission'],
      trustState: 'benign',
      trustSummary: '安全，无风险',
      installEligibility: { status: 'installable' },
    })
  })

  it('falls back to SkillHub skill version when latestVersion is missing', () => {
    const detail = normalizeSkillHubDetail({
      securityReports: {
        keen: { status: 'benign', statusText: 'safe' },
      },
      skill: {
        slug: 'legacy-version-skill',
        displayName: 'Legacy Version Skill',
        version: '0.9.0',
      },
    })

    expect(detail.version).toBe('0.9.0')
  })

  it('blocks SkillHub details with warning security reports', () => {
    for (const status of ['warning', 'suspicious']) {
      const detail = normalizeSkillHubDetail({
        securityReports: {
          staticAnalysis: { status, statusText: 'Potentially risky tool use.' },
        },
        skill: {
          slug: `${status}-skill`,
          displayName: `${status} Skill`,
        },
      })

      expect(detail.trustState).toBe('warning')
      expect(detail.trustSummary).toBe('Potentially risky tool use.')
      expect(detail.installEligibility).toEqual({
        status: 'blocked',
        reason: 'SkillHub security report returned warnings.',
      })
    }
  })

  it('blocks SkillHub details when security reports are missing', () => {
    const detail = normalizeSkillHubDetail({
      skill: {
        slug: 'unreviewed-skill',
        displayName: 'Unreviewed Skill',
      },
    })

    expect(detail.trustState).toBe('unknown')
    expect(detail.installEligibility.status).toBe('blocked')
    expect(detail.installEligibility.reason).toMatch(/security report is missing or inconclusive/i)
  })

  it('blocks SkillHub details when security reports are mixed or inconclusive', () => {
    const detail = normalizeSkillHubDetail({
      securityReports: {
        community: { status: 'benign', statusText: 'safe' },
        staticAnalysis: { status: 'pending-review', statusText: 'Scanner still reviewing.' },
      },
      skill: {
        slug: 'mixed-report-skill',
        displayName: 'Mixed Report Skill',
      },
    })

    expect(detail.trustState).toBe('unknown')
    expect(detail.trustSummary).toBeUndefined()
    expect(detail.installEligibility.status).toBe('blocked')
    expect(detail.installEligibility.reason).toMatch(/security report is missing or inconclusive/i)
  })

  it('does not use unscored SkillHub report summaries for unknown details', () => {
    const detail = normalizeSkillHubDetail({
      securityReports: {
        community: { status: 'benign', statusText: 'safe' },
        staticAnalysis: { statusText: 'No issues detected.' },
      },
      skill: {
        slug: 'unscored-report-skill',
        displayName: 'Unscored Report Skill',
      },
    })

    expect(detail.trustState).toBe('unknown')
    expect(detail.trustSummary).toBeUndefined()
    expect(detail.installEligibility.status).toBe('blocked')
    expect(detail.installEligibility.reason).toMatch(/security report is missing or inconclusive/i)
  })

  it('uses malicious SkillHub report summaries for blocked details', () => {
    const detail = normalizeSkillHubDetail({
      securityReports: {
        community: { status: 'benign', statusText: 'safe' },
        staticAnalysis: { status: 'malicious', statusText: 'Credential exfiltration detected.' },
      },
      skill: {
        slug: 'skill-vetter',
        displayName: 'Skill Vetter',
      },
    })

    expect(detail).toMatchObject({
      trustState: 'blocked',
      trustSummary: 'Credential exfiltration detected.',
    })
  })
})

describe('skill market service source selection', () => {
  it('uses ClawHub only in auto mode when ClawHub succeeds and marks installed skills', async () => {
    const fetchCalls: string[] = []
    const service = createSkillMarketService({
      fetchImpl: async (url) => {
        fetchCalls.push(String(url))
        return Response.json(CLAWHUB_TOP_SKILLS_RESPONSE)
      },
      installedSkillNames: async () => new Set(['skill-vetter']),
    })

    const result = await service.listSkills({ source: 'auto', limit: 12, query: 'vetter', cursor: 'next-page' })

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toStartWith('https://clawhub.ai/api/v1/skills')
    expect(fetchCalls[0]).toContain('sort=downloads')
    expect(fetchCalls[0]).toContain('nonSuspiciousOnly=true')
    expect(fetchCalls[0]).toContain('limit=12')
    expect(fetchCalls[0]).toContain('query=vetter')
    expect(fetchCalls[0]).toContain('cursor=next-page')
    expect(result).toMatchObject({
      source: 'clawhub',
      sourceStatus: 'ok',
      items: [
        {
          source: 'clawhub',
          slug: 'skill-vetter',
          installed: true,
        },
      ],
    })
  })

  it('falls back to SkillHub in auto mode when ClawHub fails and marks installed skills', async () => {
    const fetchCalls: string[] = []
    const service = createSkillMarketService({
      fetchImpl: async (url) => {
        fetchCalls.push(String(url))
        if (String(url).startsWith('https://clawhub.ai/')) {
          return new Response('temporarily unavailable', { status: 503 })
        }
        return Response.json(SKILLHUB_TOP_SKILLS_RESPONSE)
      },
      installedSkillNames: new Set(['skill-vetter']),
    })

    const result = await service.listSkills({ source: 'auto', limit: 10, query: 'vetter', cursor: '3' })

    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0]).toStartWith('https://clawhub.ai/api/v1/skills')
    expect(fetchCalls[1]).toStartWith('https://api.skillhub.cn/api/skills')
    expect(fetchCalls[1]).toContain('sortBy=downloads')
    expect(fetchCalls[1]).toContain('order=desc')
    expect(fetchCalls[1]).toContain('limit=10')
    expect(fetchCalls[1]).toContain('query=vetter')
    expect(fetchCalls[1]).toContain('cursor=3')
    expect(result.source).toBe('skillhub')
    expect(result.sourceStatus).toBe('fallback')
    expect(result.message).toContain('ClawHub unavailable')
    expect(result.items[0]).toMatchObject({
      source: 'skillhub',
      slug: 'skill-vetter',
      installed: true,
    })
  })

  it("does not fallback to SkillHub when source is 'clawhub'", async () => {
    const fetchCalls: string[] = []
    const service = createSkillMarketService({
      fetchImpl: async (url) => {
        fetchCalls.push(String(url))
        return new Response('temporarily unavailable', { status: 503 })
      },
      installedSkillNames: async () => new Set(),
    })

    await expect(service.listSkills({ source: 'clawhub' })).rejects.toThrow('ClawHub request failed')

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toStartWith('https://clawhub.ai/api/v1/skills')
  })

  it("uses SkillHub only when source is 'skillhub'", async () => {
    const fetchCalls: string[] = []
    const service = createSkillMarketService({
      fetchImpl: async (url) => {
        fetchCalls.push(String(url))
        return Response.json(SKILLHUB_TOP_SKILLS_RESPONSE)
      },
      installedSkillNames: async () => new Set(),
    })

    const result = await service.listSkills({ source: 'skillhub', limit: 6, query: 'vetter', cursor: '2' })

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toStartWith('https://api.skillhub.cn/api/skills')
    expect(fetchCalls[0]).toContain('sortBy=downloads')
    expect(fetchCalls[0]).toContain('order=desc')
    expect(fetchCalls[0]).toContain('limit=6')
    expect(fetchCalls[0]).toContain('query=vetter')
    expect(fetchCalls[0]).toContain('cursor=2')
    expect(result.source).toBe('skillhub')
    expect(result.items[0]).toMatchObject({
      source: 'skillhub',
      slug: 'skill-vetter',
      installed: false,
    })
  })

  it('rejects unsupported v1 sources instead of treating them as auto', async () => {
    const fetchCalls: string[] = []
    const service = createSkillMarketService({
      fetchImpl: async (url) => {
        fetchCalls.push(String(url))
        return Response.json(CLAWHUB_TOP_SKILLS_RESPONSE)
      },
      installedSkillNames: async () => new Set(),
    })

    await expect(
      service.listSkills({ source: 'anthropic-github' as 'auto' }),
    ).rejects.toThrow('Unsupported skill market source')

    expect(fetchCalls).toHaveLength(0)
  })
})
