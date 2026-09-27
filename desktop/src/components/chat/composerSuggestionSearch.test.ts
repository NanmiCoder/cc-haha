import { expect, it } from 'vitest'
import { rankComposerSuggestions } from '@/components/chat/composerSuggestionSearch'

it('ranks exact names, prefixes, name matches, then description matches in stable order', () => {
  const items = [
    { label: 'Other', description: 'Design interfaces' },
    { label: 'My design' },
    { label: 'Design tools' },
    { label: 'Design' },
    { label: 'Design systems' },
  ]
  expect(rankComposerSuggestions(items, 'design').map(item => item.label)).toEqual(['Design', 'Design tools', 'Design systems', 'My design', 'Other'])
})

it('matches aliases and normalized paths and limits cross-source results', () => {
  const file = { label: 'index.ts', searchTerms: ['src/index.ts'] }
  expect(rankComposerSuggestions([file], 'src\\index')).toEqual([file])
  expect(rankComposerSuggestions(Array.from({ length: 12 }, (_, i) => ({ label: `item ${i}` })), 'item')).toHaveLength(8)
  expect(rankComposerSuggestions([{ label: 'no match' }], 'absent')).toEqual([])
})
