import { beforeEach, expect, it, vi } from 'vitest'
import type { VoiceVocabulary } from '@/api/voice'

vi.mock('@/api/voice', () => ({ voiceApi: {
  vocabulary: vi.fn(), addVocabulary: vi.fn(), updateVocabulary: vi.fn(),
  removeVocabulary: vi.fn(), dismissSuggestion: vi.fn(),
} }))

import { voiceApi } from '@/api/voice'
import { useVoiceVocabularyStore } from './voiceVocabularyStore'

const api = vi.mocked(voiceApi)
const store = () => useVoiceVocabularyStore.getState()
const vocabulary = (...terms: string[]): VoiceVocabulary => ({
  terms: terms.map(term => ({ term, aliases: [], source: 'manual', addedAt: '2026-11-04T00:00:00Z' })),
  suggestions: [], history: null, maxTerms: 500,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  useVoiceVocabularyStore.setState({ vocabulary: vocabulary('old'), loading: false, error: null })
})

it.each(['add', 'update', 'remove', 'dismissSuggestion'] as const)('protects a confirmed %s against a late refresh', async (action) => {
  const pending = deferred<VoiceVocabulary>()
  api.vocabulary.mockReturnValueOnce(pending.promise)
  const loading = store().load({ force: true })
  const saved = vocabulary('new')
  api.addVocabulary.mockResolvedValueOnce({ vocabulary: saved, added: 1, merged: 0, skipped: 0 })
  api.updateVocabulary.mockResolvedValueOnce({ vocabulary: saved })
  api.removeVocabulary.mockResolvedValueOnce({ vocabulary: saved })
  api.dismissSuggestion.mockResolvedValueOnce({ vocabulary: saved })
  if (action === 'add') await store().add([{ term: 'new' }])
  else if (action === 'update') await store().update('old', { term: 'new', aliases: [] })
  else await store()[action]('old')
  pending.resolve(vocabulary('old'))
  await loading
  expect(store().vocabulary).toEqual(saved)
})

it('ignores an obsolete read error after a successful mutation', async () => {
  const pending = deferred<VoiceVocabulary>()
  api.vocabulary.mockReturnValueOnce(pending.promise)
  const loading = store().load({ force: true })
  api.removeVocabulary.mockResolvedValueOnce({ vocabulary: vocabulary() })
  await store().remove('old')
  pending.reject(new Error('old read failed'))
  await loading
  expect(store().error).toBeNull()
  expect(store().vocabulary?.terms).toHaveLength(0)
})

it('queues vocabulary mutations so an earlier response cannot remove a later result', async () => {
  const pending = deferred<{ vocabulary: VoiceVocabulary }>()
  api.removeVocabulary.mockReturnValueOnce(pending.promise)
  api.addVocabulary.mockResolvedValueOnce({ vocabulary: vocabulary('new'), added: 1, merged: 0, skipped: 0 })
  const removing = store().remove('old')
  const adding = store().add([{ term: 'new' }])
  await Promise.resolve()
  expect(api.addVocabulary).not.toHaveBeenCalled()
  pending.resolve({ vocabulary: vocabulary() })
  await Promise.all([removing, adding])
  expect(store().vocabulary).toEqual(vocabulary('new'))
})

it('allows the next mutation after a rejection', async () => {
  api.removeVocabulary.mockRejectedValueOnce(new Error('offline'))
  api.addVocabulary.mockResolvedValueOnce({ vocabulary: vocabulary('new'), added: 1, merged: 0, skipped: 0 })
  const removing = store().remove('old').catch(error => error)
  const adding = store().add([{ term: 'new' }])
  expect(await removing).toBeInstanceOf(Error)
  await adding
  expect(store().vocabulary).toEqual(vocabulary('new'))
})

it('joins ordinary reads and coalesces forced refreshes while loading', async () => {
  const pending = deferred<VoiceVocabulary>()
  api.vocabulary.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(vocabulary('fresh'))
  const first = store().load({ force: true })
  let joined = false
  const second = store().load().then(() => { joined = true })
  const forced = store().load({ force: true })
  const alsoForced = store().load({ force: true })
  await Promise.resolve()
  expect(joined).toBe(false)
  pending.resolve(vocabulary('stale'))
  await Promise.all([first, second, forced, alsoForced])
  expect(api.vocabulary).toHaveBeenCalledTimes(2)
  expect(store().vocabulary).toEqual(vocabulary('fresh'))
})
