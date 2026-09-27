import { expect, mock, test } from 'bun:test'
import { SearchService } from './searchService.js'

test('session suggestions use only projected IDs even when files are unavailable', async () => {
  const forbidden = mock(() => { throw new Error('Transcript IO is forbidden for suggestions') })
  const service = new SearchService({
    searchIndexedContent: forbidden, readEntriesAtLines: forbidden,
    getMetadataForPaths: forbidden, getCandidatesForFilters: forbidden, resolveRipgrepCommand: forbidden,
    suggestIndexedSessions: () => ({ sessions: [{ ownerSessionId: 'id', ownerTranscriptPath: '/missing/id.jsonl', projectPath: '-repo', modifiedAtMs: 1 }], truncated: true }),
  })
  expect(await service.searchSessionSuggestions('修复')).toEqual({ sessions: [{ sessionId: 'id', ownerTranscriptPath: '/missing/id.jsonl', projectPath: '-repo', modifiedAt: new Date(1).toISOString() }], truncated: true, indexUnavailable: false })
  expect(forbidden).not.toHaveBeenCalled()
})

test('unready indexes produce an explicit partial response without fallback and honor cancellation', async () => {
  const forbidden = mock(() => { throw new Error('No fallback') })
  const service = new SearchService({ suggestIndexedSessions: () => null, searchIndexedContent: forbidden, resolveRipgrepCommand: forbidden })
  expect(await service.searchSessionSuggestions('修复')).toEqual({ sessions: [], truncated: true, indexUnavailable: true })
  expect(forbidden).not.toHaveBeenCalled()
  const controller = new AbortController()
  controller.abort()
  await expect(service.searchSessionSuggestions('修复', { signal: controller.signal })).rejects.toThrow()
  const during = new AbortController()
  const cancelling = new SearchService({ suggestIndexedSessions: () => { during.abort(); return null } })
  await expect(cancelling.searchSessionSuggestions('修复', { signal: during.signal })).rejects.toThrow()
})
