import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { isGoalPromptHookCommand } from '../../goals/goalState.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { safeParseJSON } from '../json.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import { isFirstPartyAnthropicBaseUrl } from '../model/providers.js'
import type { PromptHook } from '../settings/types.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { modelSupportsThinking, type ThinkingConfig } from '../thinking.js'
import { addArgumentsToPrompt, hookResponseSchema } from './hookHelpers.js'

function resolvePromptHookThinkingConfig(
  model: string,
  sessionThinkingConfig: ThinkingConfig | undefined,
): ThinkingConfig {
  if (
    !isFirstPartyAnthropicBaseUrl() &&
    sessionThinkingConfig &&
    sessionThinkingConfig.type !== 'disabled' &&
    modelSupportsThinking(model)
  ) {
    return sessionThinkingConfig
  }
  return { type: 'disabled' }
}

function formatPromptHookApiErrorDetail(
  fullResponse: string,
  fallback?: string,
): string {
  const raw = fullResponse || fallback || 'Unknown API error'
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    const parsed = safeParseJSON(raw.slice(jsonStart)) as {
      error?: { message?: unknown }
      message?: unknown
    } | null
    const extracted =
      typeof parsed?.error?.message === 'string'
        ? parsed.error.message.trim()
        : typeof parsed?.message === 'string'
          ? parsed.message.trim()
          : ''
    if (extracted) {
      const prefix = raw.slice(0, jsonStart).trim()
      return prefix ? `${prefix} ${extracted}` : extracted
    }
  }
  return raw
}

function goalHookFailureResult(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  toolUseID: string,
  reason: string,
  stdout = '',
): HookResult | null {
  if (!isGoalPromptHookCommand(hook.prompt)) return null

  return {
    hook,
    outcome: 'non_blocking_error',
    message: createAttachmentMessage({
      type: 'hook_non_blocking_error',
      hookName,
      toolUseID,
      hookEvent,
      stderr: `Goal evaluator failed: ${reason}`,
      stdout,
      exitCode: 1,
    }),
  }
}

/**
 * Execute a prompt-based hook using an LLM
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal | undefined,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // Use provided toolUseID or generate a new one
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  try {
    // Replace $ARGUMENTS with the JSON input
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(
      `Hooks: Processing prompt hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })

    // Prepend conversation history if provided
    const messagesToQuery =
      messages && messages.length > 0
        ? [...messages, userMessage]
        : [userMessage]

    logForDebugging(
      `Hooks: Querying model with ${messagesToQuery.length} messages`,
    )

    // Query the model with Haiku
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000

    // Combined signal: aborts if either the hook signal or timeout triggers
    const { signal: combinedSignal, cleanup: cleanupSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })

    try {
      const evaluatorModel = hook.model ?? getSmallFastModel()
      const response = await queryModelWithoutStreaming({
        messages: messagesToQuery,
        systemPrompt: asSystemPrompt([
          `You are evaluating a hook in Claude Code.

Your response must be a JSON object matching one of the following schemas:
1. If the condition is met, return: {"ok": true}
2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}`,
        ]),
        thinkingConfig: resolvePromptHookThinkingConfig(
          evaluatorModel,
          toolUseContext.options?.thinkingConfig,
        ),
        tools: toolUseContext.options.tools,
        signal: combinedSignal,
        options: {
          async getToolPermissionContext() {
            const appState = toolUseContext.getAppState()
            return appState.toolPermissionContext
          },
          model: evaluatorModel,
          toolChoice: undefined,
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          agents: [],
          querySource: 'hook_prompt',
          mcpTools: [],
          agentId: toolUseContext.agentId,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      })

      cleanupSignal()

      // Extract text content from response
      const content = extractTextContent(response.message.content)

      // Update response length for spinner display
      toolUseContext.setResponseLength(length => length + content.length)

      const fullResponse = content.trim()
      if (response.isApiErrorMessage) {
        const apiErrorDetail = formatPromptHookApiErrorDetail(
          fullResponse,
          response.apiError || response.error,
        )
        logForDebugging(`Hooks: Prompt hook API error: ${apiErrorDetail}`)
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: isGoalPromptHookCommand(hook.prompt)
              ? `Goal evaluator API error: ${apiErrorDetail}`
              : `Prompt hook API error: ${apiErrorDetail}`,
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      logForDebugging(`Hooks: Model response: ${fullResponse}`)

      const json = safeParseJSON(fullResponse)
      if (!json) {
        logForDebugging(
          `Hooks: error parsing response as JSON: ${fullResponse}`,
        )
        const goalFailure = goalHookFailureResult(
          hook,
          hookName,
          hookEvent,
          effectiveToolUseID,
          'response was not valid JSON',
          fullResponse,
        )
        if (goalFailure) return goalFailure

        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        const goalFailure = goalHookFailureResult(
          hook,
          hookName,
          hookEvent,
          effectiveToolUseID,
          `response did not match the expected schema (${parsed.error.message})`,
          fullResponse,
        )
        if (goalFailure) return goalFailure

        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      // Failed to meet condition
      if (!parsed.data.ok) {
        logForDebugging(
          `Hooks: Prompt hook condition was not met: ${parsed.data.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Prompt hook condition was not met: ${parsed.data.reason}`,
            command: hook.prompt,
          },
          preventContinuation: true,
          stopReason: parsed.data.reason,
        }
      }

      // Condition was met
      logForDebugging(`Hooks: Prompt hook condition was met`)
      return {
        hook,
        outcome: 'success',
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        const goalFailure = signal?.aborted
          ? null
          : goalHookFailureResult(
              hook,
              hookName,
              hookEvent,
              effectiveToolUseID,
              'evaluation timed out',
            )
        if (goalFailure) return goalFailure

        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    const goalFailure = goalHookFailureResult(
      hook,
      hookName,
      hookEvent,
      effectiveToolUseID,
      errorMsg || 'evaluation failed',
    )
    if (goalFailure) return goalFailure

    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}
