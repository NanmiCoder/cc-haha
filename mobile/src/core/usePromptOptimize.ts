import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { ApiClient } from './client'
import { cancelOptimizePrompt, optimizePrompt } from './promptOptimizeApi'
import {
  createPromptOptimize,
  initialPromptOptimizeState,
  PROMPT_OPTIMIZE_NOTICE_MS,
  PROMPT_OPTIMIZE_RESTORE_MS,
  type PromptOptimizeController,
} from './promptOptimize'
import { randomRequestId } from './requestId'

type Options = {
  client: ApiClient | null
  sessionId?: string
  contextKey: string
  draft: string
  blocked: boolean
  onDraft(text: string): void
  focus(): void
  newRequestId?: () => string
}

function defaultRequestId(): string {
  if (
    typeof globalThis.crypto?.randomUUID === 'function' ||
    typeof globalThis.crypto?.getRandomValues === 'function'
  ) {
    return randomRequestId(globalThis.crypto)
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16)
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8
    return value.toString(16)
  })
}

export function usePromptOptimize(options: Options) {
  const [state, setState] = useState(initialPromptOptimizeState)
  const latest = useRef(options)
  const mounted = useRef(true)
  const pendingWrite = useRef<{ next: string } | null>(null)
  const previousDraft = useRef(options.draft)
  const previousContext = useRef(options.contextKey)
  const controller = useRef<PromptOptimizeController<ApiClient> | null>(null)

  useLayoutEffect(() => {
    latest.current = options
    controller.current ??= createPromptOptimize<ApiClient>({
      read: () => ({
        key: latest.current.contextKey,
        client: latest.current.client,
        sessionId: latest.current.sessionId ?? null,
        text: latest.current.draft,
        blocked: latest.current.blocked || !latest.current.client,
      }),
      write: (text) => {
        pendingWrite.current = { next: text }
        latest.current.onDraft(text)
      },
      focus: () => latest.current.focus(),
      changed: (next) => {
        if (mounted.current) setState(next)
      },
      newRequestId: () => (latest.current.newRequestId ?? defaultRequestId)(),
      optimize: (client, sessionId, body, signal) =>
        optimizePrompt(client, sessionId, body, signal),
      cancel: (client, sessionId, requestId) =>
        cancelOptimizePrompt(client, sessionId, requestId),
    })

    if (previousContext.current !== options.contextKey) {
      previousContext.current = options.contextKey
      previousDraft.current = options.draft
      pendingWrite.current = null
      return
    }

    if (previousDraft.current !== options.draft) {
      previousDraft.current = options.draft
      if (pendingWrite.current?.next === options.draft) {
        pendingWrite.current = null
      } else {
        pendingWrite.current = null
        controller.current.edited()
      }
    }
  }, [options])

  const abandon = useCallback(() => {
    pendingWrite.current = null
    controller.current?.abandon()
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      abandon()
    }
  }, [abandon])

  // Leaving the chat screen (e.g. pushing /files or /changes) aborts any
  // in-flight optimization so it cannot mutate offscreen state or focus input.
  useFocusEffect(useCallback(() => abandon, [abandon]))

  // Switching session or host aborts synchronously before any late response can
  // land on the new chat's draft.
  useLayoutEffect(() => abandon, [abandon, options.client, options.contextKey])

  const restoreId = state.restoreSnapshot?.id
  useEffect(() => {
    if (restoreId === undefined) return
    const timer = setTimeout(() => {
      controller.current?.dismissRestore()
    }, PROMPT_OPTIMIZE_RESTORE_MS)
    return () => clearTimeout(timer)
  }, [restoreId])

  useEffect(() => {
    if (!state.notice) return
    const timer = setTimeout(() => {
      controller.current?.dismissNotice()
    }, PROMPT_OPTIMIZE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [state.notice])

  return {
    ...state,
    optimizing: state.phase === 'optimizing',
    optimize: () => {
      void controller.current?.optimize()
    },
    cancel: () => controller.current?.cancel(),
    restore: () => controller.current?.restore(),
    edited: () => {
      pendingWrite.current = null
      controller.current?.edited()
    },
    dismissRestore: () => controller.current?.dismissRestore(),
    dismissNotice: () => controller.current?.dismissNotice(),
    dismissIssue: () => controller.current?.dismissIssue(),
  }
}

export type ComposerPromptOptimize = ReturnType<typeof usePromptOptimize>
