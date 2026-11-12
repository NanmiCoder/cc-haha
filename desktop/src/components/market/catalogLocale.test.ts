import { describe, expect, it } from 'vitest'

import type { MarketCategory } from '../../types/market'
import { categoryLabel, resolveCategory, skillSummary, visibleTags } from './catalogLocale'
import { formatCount, formatIsoDate, safeUrl } from './marketFormat'

const CATEGORIES: MarketCategory[] = [
  { key: 'dev', name: '开发编程', nameEn: 'Development', count: 40 },
  { key: 'office', name: '办公文档', nameEn: '', count: 36 },
]

describe('catalog locale', () => {
  it('shows the upstream English summary, falling back to the original', () => {
    const skill = { summary: '用文件跟踪任务', summaryEn: 'Track tasks in files' }
    expect(skillSummary(skill, 'en')).toBe('Track tasks in files')
    // No English copy: the original summary beats an empty card.
    expect(skillSummary({ summary: '只有中文' }, 'en')).toBe('只有中文')
  })

  it('hides untranslated curated tags but keeps upstream tags', () => {
    expect(visibleTags({ tags: ['任务规划'], curated: true }, 'en')).toEqual([])
    expect(visibleTags({ tags: ['git'], curated: false }, 'en')).toEqual(['git'])
  })

  it('labels categories in English and falls back to the original name', () => {
    expect(categoryLabel(CATEGORIES[0]!, 'en')).toBe('Development')
    expect(categoryLabel(CATEGORIES[1]!, 'en')).toBe('办公文档')
  })

  it('resolves catalog keys only on curated skills and passes raw upstream strings through', () => {
    expect(resolveCategory({ category: 'dev', curated: true }, CATEGORIES, 'en')).toBe('Development')
    expect(resolveCategory({ category: 'unknown-key', curated: true }, CATEGORIES, 'en')).toBeUndefined()
    expect(resolveCategory({ category: 'AI 工具', curated: false }, CATEGORIES, 'en')).toBe('AI 工具')
    expect(resolveCategory({ curated: true }, CATEGORIES, 'en')).toBeUndefined()
  })
})

describe('market formatting', () => {
  it('compacts counts', () => {
    expect(formatCount(999)).toBe('999')
    expect(formatCount(482_069)).toBe('482.1k')
    expect(formatCount(2_400_000)).toBe('2.4M')
  })

  it('renders epoch millis as an ISO date and ignores garbage', () => {
    expect(formatIsoDate(Date.UTC(2026, 9, 1))).toBe('2026-10-01')
    expect(formatIsoDate(undefined)).toBe('')
    expect(formatIsoDate(Number.NaN)).toBe('')
  })

  it('only lets http(s) links through', () => {
    expect(safeUrl('https://clawhub.ai/x')).toBe('https://clawhub.ai/x')
    expect(safeUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeUrl(undefined)).toBeUndefined()
  })
})
