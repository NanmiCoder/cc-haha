import { describe, expect, it } from 'vitest'

import {
  highlightSegments,
  initialProviderTab,
  matchProviderFields,
  providerTabOf,
  searchTerms,
  type ProviderSearchField,
} from './providerListSearch'

describe('provider tabs', () => {
  it('puts Claude Official (null) and the sign-in providers on the official tab', () => {
    expect(providerTabOf(null)).toBe('official')
    expect(providerTabOf('openai-official')).toBe('official')
    expect(providerTabOf('deepseek-account')).toBe('official')
    expect(providerTabOf('saved-1')).toBe('api')
  })

  it('opens on API Key unless a sign-in provider was chosen on purpose', () => {
    // Adding a provider leaves Claude Official as the default, so null is not a choice.
    expect(initialProviderTab(null)).toBe('api')
    expect(initialProviderTab('saved-1')).toBe('api')
    expect(initialProviderTab('grok-official')).toBe('official')
  })
})

describe('matchProviderFields', () => {
  const fields: ProviderSearchField[] = [
    { value: 'Gateway', visible: true },
    { value: 'https://api.example.test · main-model', visible: true },
    { value: 'haiku-model', visible: false, label: 'Haiku' },
    { value: 'paid by finance', visible: false, label: 'Notes' },
  ]

  it('matches everything for an empty query', () => {
    expect(searchTerms('   ')).toEqual([])
    expect(matchProviderFields(fields, [])).toEqual({ hiddenField: null })
  })

  it('requires every term, each in any field, ignoring case', () => {
    expect(matchProviderFields(fields, searchTerms('GATEWAY example'))).toEqual({ hiddenField: null })
    expect(matchProviderFields(fields, searchTerms('gateway missing'))).toBeNull()
  })

  it('names the hidden field only when no visible field carries the term', () => {
    expect(matchProviderFields(fields, searchTerms('haiku'))).toEqual({
      hiddenField: { label: 'Haiku', value: 'haiku-model' },
    })
    // "model" is on the card already, so there is nothing to explain.
    expect(matchProviderFields(fields, searchTerms('model'))).toEqual({ hiddenField: null })
    expect(matchProviderFields(fields, searchTerms('gateway finance'))).toEqual({
      hiddenField: { label: 'Notes', value: 'paid by finance' },
    })
  })
})

describe('highlightSegments', () => {
  it('returns the text untouched without terms', () => {
    expect(highlightSegments('DeepSeek', [])).toEqual([{ text: 'DeepSeek', match: false }])
  })

  it('marks every occurrence of every term and merges overlaps', () => {
    expect(highlightSegments('deepseek/DeepSeek-v4', ['deepseek'])).toEqual([
      { text: 'deepseek', match: true },
      { text: '/', match: false },
      { text: 'DeepSeek', match: true },
      { text: '-v4', match: false },
    ])
    expect(highlightSegments('abcdef', ['bcd', 'cde'])).toEqual([
      { text: 'a', match: false },
      { text: 'bcde', match: true },
      { text: 'f', match: false },
    ])
  })

  it('leaves text alone when lowercasing would shift the offsets', () => {
    expect(highlightSegments('İstanbul', ['stan'])).toEqual([{ text: 'İstanbul', match: false }])
  })
})
