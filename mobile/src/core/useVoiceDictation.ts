import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { ApiClient } from './client'
import { loadVoiceCatalog, transcribeVoice } from './voiceApi'
import { startVoiceRecording } from './voiceRecorder'
import { createVoiceDictation, initialVoiceDictationState, type VoiceDictation, type VoiceSelection } from './voiceDictation'

type Options = {
  client: ApiClient | null
  contextKey: string
  draft: string
  selection: VoiceSelection
  blocked: boolean
  canSend: boolean
  onDraft(text: string, cursor: number): void
  onSubmit(): void
  focus(): void
}

export function useVoiceDictation(options: Options) {
  const [state, setState] = useState(initialVoiceDictationState)
  const latest = useRef(options)
  const previousDraft = useRef(options.draft)
  const revision = useRef(0)
  const mounted = useRef(true)
  const pendingSend = useRef<{ key: string, text: string, before: string } | null>(null)
  const controller = useRef<VoiceDictation | null>(null)
  useLayoutEffect(() => {
    latest.current = options
    if (previousDraft.current !== options.draft) {
      previousDraft.current = options.draft
      revision.current++
    }
    controller.current ??= createVoiceDictation({
      read: () => ({
        key: latest.current.contextKey,
        text: latest.current.draft,
        revision: revision.current,
        selection: latest.current.selection,
        blocked: latest.current.blocked || !latest.current.client,
        canSend: latest.current.canSend,
      }),
      write: (text, cursor) => latest.current.onDraft(text, cursor),
      submitAfterWrite: text => {
        pendingSend.current = { key: latest.current.contextKey, text, before: latest.current.draft }
      },
      focus: () => latest.current.focus(),
      changed: next => { if (mounted.current) setState(next) },
      catalog: signal => loadVoiceCatalog(latest.current.client!, signal),
      record: startVoiceRecording,
      transcribe: (wav, settings) => transcribeVoice(latest.current.client!, wav, settings),
    })
  }, [options])
  const abandon = useCallback(() => {
    pendingSend.current = null
    controller.current?.abandon()
  }, [])
  const getLevel = useCallback(() => controller.current?.getLevel() ?? 0, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      abandon()
    }
  }, [abandon])
  useFocusEffect(useCallback(() => abandon, [abandon]))
  useEffect(() => abandon, [abandon, options.client, options.contextKey])
  useEffect(() => {
    const listener = AppState.addEventListener('change', next => {
      // Android's permission Activity also reports background. Capture has not
      // started then; its adapter waits for active before opening the mic.
      if (next === 'background' && !controller.current?.isPermissionRequestPending()) abandon()
    })
    return () => listener.remove()
  }, [abandon])

  useEffect(() => {
    const pending = pendingSend.current
    if (!pending) return
    const current = latest.current
    if (pending.key !== current.contextKey || !current.canSend || current.blocked) {
      pendingSend.current = null
      return
    }
    // The parent must first accept onDraft. Calling onSubmit in the async
    // transcription callback would send the previous render's draft.
    if (current.draft === pending.before && pending.text !== pending.before) return
    pendingSend.current = null
    if (current.draft === pending.text) current.onSubmit()
  }, [state, options.draft, options.contextKey, options.blocked, options.canSend])

  return {
    ...state,
    live: state.phase !== 'idle',
    getLevel,
    start: () => controller.current?.start(),
    stop: () => { void controller.current?.stop() },
    stopAndSend: () => { void controller.current?.stop(true) },
    cancel: () => {
      pendingSend.current = null
      controller.current?.cancel()
    },
    insertPending: () => controller.current?.insertPending(),
    dismissPending: () => controller.current?.dismissPending(),
    dismissIssue: () => controller.current?.dismissIssue(),
    /** Even a type-and-delete in one render invalidates the captured caret. */
    edited: () => {
      revision.current++
      pendingSend.current = null
    },
  }
}

export type ComposerVoiceDictation = ReturnType<typeof useVoiceDictation>
