import type { RequestCompatibility } from '../../types/provider.js'
import type { OutputBudgetSource } from '../../../services/api/outputBudget.js'
import type { AnthropicRequest } from './types.js'

export type RequestCompatibilityOptions = {
  requestCompatibility?: RequestCompatibility
  budgetSource?: OutputBudgetSource
  openAICodexOAuth?: boolean
  passSamplingParams?: boolean
}

export type ResolvedOutputBudget = {
  source: OutputBudgetSource
  requested?: number
  configured?: number
  effective?: number
  field: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | 'omit'
  reason: 'explicit_request' | 'provider_default' | 'upstream_default' | 'hard_limit' | 'responses_minimum' | 'provider_omit' | 'oauth_omit'
  hardLimit?: number
}

export class RequestCompatibilityError extends Error {
  readonly type = 'invalid_request_error'
  readonly status = 400
}

export type StructuredOutputFormat = {
  type: 'json_schema'
  name: string
  description?: string
  schema: Record<string, unknown>
  strict: false
}

/** Resolve wire policy once for both saved-provider probes and production. */
export function resolveRequestCompatibility(
  body: AnthropicRequest,
  options: RequestCompatibilityOptions & { protocol: 'openai_chat' | 'openai_responses' },
): {
  outputBudget: ResolvedOutputBudget
  passSamplingParams: boolean
  passReasoning: boolean
  parallelToolCalls?: boolean
  structuredOutput?: StructuredOutputFormat
} {
  const compatibility = options.requestCompatibility ?? {}
  const source = options.budgetSource ?? 'explicit'
  const requested = body.max_tokens
  if (!options.openAICodexOAuth && (!Number.isSafeInteger(requested) || requested <= 0)) {
    throw new RequestCompatibilityError('The output budget must be a positive integer')
  }
  const hardLimit = compatibility.outputTokenLimit
  const configured = source === 'default' ? compatibility.maxOutputTokens : undefined
  const outputBudget: ResolvedOutputBudget = {
    source, requested, field: 'omit', reason: 'upstream_default',
    ...(configured !== undefined ? { configured } : {}),
    ...(hardLimit !== undefined ? { hardLimit } : {}),
  }
  if (options.openAICodexOAuth) {
    // This dedicated backend does not accept an output-budget field. Keep
    // that exception observable instead of implying the local budget was sent.
    outputBudget.reason = 'oauth_omit'
  } else if (compatibility.outputTokenField === 'omit') {
    if (source === 'explicit' || configured !== undefined || hardLimit !== undefined) {
      throw new RequestCompatibilityError('This endpoint is configured to omit the output budget and cannot honor an explicit or configured output budget')
    }
    outputBudget.reason = 'provider_omit'
  } else if (source === 'explicit' || configured !== undefined || hardLimit !== undefined) {
    let effective = configured ?? (source === 'default' ? hardLimit! : requested)
    outputBudget.reason = configured !== undefined ? 'provider_default' : source === 'default' ? 'hard_limit' : 'explicit_request'
    if (hardLimit !== undefined && effective > hardLimit) {
      effective = hardLimit
      outputBudget.reason = 'hard_limit'
    }
    if (options.protocol === 'openai_responses') {
      if (hardLimit !== undefined && hardLimit < 16) {
        throw new RequestCompatibilityError('The Responses output budget minimum is 16, above this endpoint output limit')
      }
      if (effective < 16) {
        effective = 16
        outputBudget.reason = 'responses_minimum'
      }
      outputBudget.field = 'max_output_tokens'
    } else {
      const override = compatibility.outputTokenField
      // Known OpenAI reasoning families use the completion budget field. An
      // explicit endpoint override handles aliases and compatible gateways.
      const completionBudget = /^(?:o\d(?:[-.]|$)|gpt-(?:[5-9]|\d{2,})(?:[-.]|$))/i.test(body.model)
      outputBudget.field = override === 'max_tokens' || override === 'max_completion_tokens'
        ? override : completionBudget ? 'max_completion_tokens' : 'max_tokens'
    }
    outputBudget.effective = effective
  }

  const selectableTools = (body.tools ?? []).filter(tool => tool.name !== 'BatchTool')
  const choice = record(body.tool_choice)
  const namedToolExists = choice?.type !== 'tool' || selectableTools.some(tool => tool.name === choice.name)
  let parallelToolCalls: boolean | undefined
  if (selectableTools.length && namedToolExists && typeof choice?.disable_parallel_tool_use === 'boolean') {
    if (compatibility.parallelTools === 'unsupported') {
      if (choice.disable_parallel_tool_use) {
        throw new RequestCompatibilityError('This endpoint cannot honor the serial tool-call constraint')
      }
    } else {
      parallelToolCalls = !choice.disable_parallel_tool_use
    }
  }

  let structuredOutput: StructuredOutputFormat | undefined
  const requestedFormat = body.output_config?.format ?? body.output_format
  const format = record(requestedFormat)
  if (requestedFormat != null && !format) {
    throw new RequestCompatibilityError('Structured output must contain a JSON schema format object')
  }
  if (format) {
    if (compatibility.structuredOutput === 'unsupported') {
      throw new RequestCompatibilityError('This endpoint does not support the requested structured output schema')
    }
    const schema = record(format.schema)
    if (format.type !== 'json_schema' || !schema) {
      throw new RequestCompatibilityError('Only a JSON schema object can be converted as structured output')
    }
    structuredOutput = {
      type: 'json_schema',
      name: typeof format.name === 'string' && format.name ? format.name : 'response',
      ...(typeof format.description === 'string' ? { description: format.description } : {}),
      schema,
      // Strict normalization can turn optional properties into required ones.
      // Preserve the caller's schema instead of silently tightening it.
      strict: false,
    }
  }

  return {
    outputBudget,
    passSamplingParams: compatibility.sampling === 'supported'
      || (compatibility.sampling !== 'unsupported' && options.passSamplingParams === true),
    passReasoning: compatibility.reasoning !== 'unsupported',
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    ...(structuredOutput ? { structuredOutput } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
