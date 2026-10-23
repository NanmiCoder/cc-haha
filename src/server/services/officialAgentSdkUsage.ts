import type { ModelUsage, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk/core'

/** Keep a stable desktop shape even if the SDK's optional live usage API changes. */
export class OfficialAgentSdkUsage {
  private startedAt = Date.now()
  private cost = 0
  private apiDuration = 0
  private models: Record<string, ModelUsage> = {}

  observe(message: SDKMessage): void {
    if (message.type !== 'result') return
    if (typeof message.total_cost_usd === 'number') this.cost = message.total_cost_usd
    if (typeof message.duration_api_ms === 'number') this.apiDuration += message.duration_api_ms
    if (message.modelUsage) this.models = message.modelUsage
  }

  async snapshot(runtime: Query, extra?: { totalCostUSD: number; modelUsage: Record<string, ModelUsage>; durationApiMs: number }): Promise<Record<string, unknown>> {
    let cost = this.cost
    let apiDuration = this.apiDuration
    let duration = Date.now() - this.startedAt
    let linesAdded = 0
    let linesRemoved = 0
    let modelUsage = this.models
    // This SDK version exposes live cost only under an experimental name. The
    // normal result events above remain the fallback if it is absent or fails.
    const live = runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof live === 'function') {
      try {
        const { session } = await live.call(runtime, { skipBehaviors: true })
        cost = session.total_cost_usd
        apiDuration = session.total_api_duration_ms
        duration = session.total_duration_ms
        linesAdded = session.total_lines_added
        linesRemoved = session.total_lines_removed
        modelUsage = session.model_usage
      } catch {}
    }
    if (extra) {
      cost += extra.totalCostUSD
      apiDuration += extra.durationApiMs
      modelUsage = mergeOfficialAgentSdkModelUsage(modelUsage, extra.modelUsage)
    }
    const models = Object.entries(modelUsage).map(([model, usage]) => ({ ...usage, model, displayName: model, costDisplay: `$${usage.costUSD.toFixed(4)}` }))
    const sum = (field: keyof ModelUsage) => models.reduce((value, model) => value + Number(model[field] ?? 0), 0)
    return {
      totalCostUSD: cost, costDisplay: `$${cost.toFixed(4)}`, hasUnknownModelCost: false,
      totalAPIDuration: apiDuration, totalDuration: duration, totalLinesAdded: linesAdded, totalLinesRemoved: linesRemoved,
      totalInputTokens: sum('inputTokens'), totalOutputTokens: sum('outputTokens'),
      totalCacheReadInputTokens: sum('cacheReadInputTokens'), totalCacheCreationInputTokens: sum('cacheCreationInputTokens'),
      totalWebSearchRequests: sum('webSearchRequests'), models,
    }
  }
}

export function mergeOfficialAgentSdkModelUsage(base: Record<string, ModelUsage>, additional: Record<string, ModelUsage>): Record<string, ModelUsage> {
  const result = { ...base }
  for (const [model, extra] of Object.entries(additional)) {
    const previous = result[model]
    if (!previous) result[model] = { ...extra }
    else result[model] = {
      ...previous,
      inputTokens: previous.inputTokens + extra.inputTokens,
      outputTokens: previous.outputTokens + extra.outputTokens,
      cacheReadInputTokens: previous.cacheReadInputTokens + extra.cacheReadInputTokens,
      cacheCreationInputTokens: previous.cacheCreationInputTokens + extra.cacheCreationInputTokens,
      webSearchRequests: previous.webSearchRequests + extra.webSearchRequests,
      costUSD: previous.costUSD + extra.costUSD,
    }
  }
  return result
}
