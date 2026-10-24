import { expect, test } from 'bun:test'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk/core'
import { OfficialAgentSdkUsage } from './officialAgentSdkUsage.js'

const model = { inputTokens: 20, outputTokens: 4, cacheReadInputTokens: 8, cacheCreationInputTokens: 2, webSearchRequests: 0, costUSD: 0.01, contextWindow: 200000, maxOutputTokens: 64000 }

test('usage keeps the desktop contract from official result events without extra model requests', async () => {
  const usage = new OfficialAgentSdkUsage()
  usage.observe({ type: 'result', total_cost_usd: 0.01, duration_api_ms: 50, modelUsage: { haiku: model } } as SDKMessage)
  expect(await usage.snapshot({} as Query)).toMatchObject({ totalCostUSD: 0.01, totalAPIDuration: 50, totalInputTokens: 20, totalOutputTokens: 4, totalCacheReadInputTokens: 8, totalCacheCreationInputTokens: 2, costDisplay: '$0.0100', models: [{ model: 'haiku', ...model }] })
})

test('live SDK totals map to desktop usage and unavailable experimental controls fall back', async () => {
  const usage = new OfficialAgentSdkUsage()
  const runtime = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ session: { total_cost_usd: 0.01, total_api_duration_ms: 55, total_duration_ms: 100, total_lines_added: 3, total_lines_removed: 2, model_usage: { haiku: model } } }) } as unknown as Query
  expect(await usage.snapshot(runtime)).toMatchObject({ totalAPIDuration: 55, totalDuration: 100, totalLinesAdded: 3, totalLinesRemoved: 2, totalOutputTokens: 4 })
  runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => { throw new Error('Unavailable') }
  expect(await usage.snapshot(runtime)).toMatchObject({ totalCostUSD: 0, totalOutputTokens: 0 })
})
