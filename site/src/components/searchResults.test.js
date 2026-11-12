import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightParts, queryTerms, searchEntries, shouldOpenSearchResult } from './searchResults.js'

const index = [
  { p: '/body', t: 'Overview', x: 'Configure desktop agents and models.' },
  { p: '/title', t: 'Desktop agents', d: 'Configure a model.' },
  { p: '/partial', t: 'Desktop' }
]

test('search requires every term and ranks title matches above body', () => {
  const result = searchEntries(index, queryTerms('  Desktop agents desktop  '), 1)
  assert.equal(result.total, 2)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].path, '/title')
  assert.deepEqual(searchEntries(index, []), { results: [], total: 0 })
})

test('body-only matches expose the matched context without an unnecessary trailing ellipsis', () => {
  const result = searchEntries(index, ['models'])
  assert.equal(result.results[0].excerpt, 'Configure desktop agents and models.')
})

test('highlights literal punctuation, preserves case and merges overlapping terms', () => {
  assert.deepEqual(highlightParts('Use C++ and desktop agents.', ['c++', 'desktop', 'desktop agents']), [
    { text: 'Use ', match: false },
    { text: 'C++', match: true },
    { text: ' and ', match: false },
    { text: 'desktop agents', match: true },
    { text: '.', match: false }
  ])
  assert.equal(highlightParts('<script>safe</script>', ['safe']).map((part) => part.text).join(''), '<script>safe</script>')
})

test('Enter opens selected results only from the combobox or an option, never close or clear controls', () => {
  const target = (role) => ({ getAttribute: () => role })
  assert.equal(shouldOpenSearchResult('Enter', target('combobox')), true)
  assert.equal(shouldOpenSearchResult('Enter', target('option')), true)
  assert.equal(shouldOpenSearchResult('Enter', target(null)), false)
  assert.equal(shouldOpenSearchResult('Escape', target('combobox')), false)
})
