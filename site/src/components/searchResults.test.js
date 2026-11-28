import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchBody } from '../../scripts/generate-docs-manifest.mjs'
import { highlightParts, queryTerms, searchEntries, shouldOpenSearchResult } from './searchResults.js'

const index = [
  { l: 'en', p: '/en/body', t: 'Overview', x: 'Configure desktop agents and models.' },
  { l: 'en', p: '/en/title', t: 'Desktop agents', d: 'Configure a model.' },
  { l: 'zh', p: '/zh', t: 'Desktop agents' },
  { l: 'en', p: '/en/partial', t: 'Desktop' }
]

test('search keeps locale, requires every term and ranks title matches above body', () => {
  const result = searchEntries(index, 'en', queryTerms('  Desktop agents desktop  '), 1)
  assert.equal(result.total, 2)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].path, '/en/title')
  assert.deepEqual(searchEntries(index, 'en', []), { results: [], total: 0 })
})

test('body-only matches expose the matched context without an unnecessary trailing ellipsis', () => {
  const result = searchEntries(index, 'en', ['models'])
  assert.equal(result.results[0].excerpt, 'Configure desktop agents and models.')
})

test('document search finds an exact environment variable and highlights the original spelling', () => {
  const entries = [
    { l: 'en', p: '/en/cli/env', t: 'Environment variables', x: searchBody('| `ANTHROPIC_BASE_URL` | _Optional_ |') },
    { l: 'zh', p: '/cli/env', t: '环境变量', x: searchBody('| `ANTHROPIC_BASE_URL` | __可选__ |') }
  ]
  const terms = queryTerms('anthropic_base_url')

  for (const entry of entries) {
    const { results } = searchEntries(entries, entry.l, terms)
    assert.deepEqual(results.map(result => result.path), [entry.p])
    assert.equal(results[0].excerpt, entry.l === 'en' ? 'ANTHROPIC_BASE_URL Optional' : 'ANTHROPIC_BASE_URL 可选')
    assert.deepEqual(highlightParts(results[0].excerpt, terms).filter(part => part.match), [
      { text: 'ANTHROPIC_BASE_URL', match: true }
    ])
  }
})

test('highlights literal punctuation, preserves case and merges overlapping terms', () => {
  assert.deepEqual(highlightParts('Use C++ and desktop agents.', ['c++', 'desktop', 'desktop agents']), [
    { text: 'Use ', match: false },
    { text: 'C++', match: true },
    { text: ' and ', match: false },
    { text: 'desktop agents', match: true },
    { text: '.', match: false }
  ])
  assert.equal(highlightParts('<script>安全</script>', ['安全']).map((part) => part.text).join(''), '<script>安全</script>')
})

test('Enter opens selected results only from the combobox or an option, never close or clear controls', () => {
  const target = (role) => ({ getAttribute: () => role })
  assert.equal(shouldOpenSearchResult('Enter', target('combobox')), true)
  assert.equal(shouldOpenSearchResult('Enter', target('option')), true)
  assert.equal(shouldOpenSearchResult('Enter', target(null)), false)
  assert.equal(shouldOpenSearchResult('Escape', target('combobox')), false)
})
