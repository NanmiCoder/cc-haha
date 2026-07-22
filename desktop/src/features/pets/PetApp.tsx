import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ChevronDown } from 'lucide-react'
import {
  desktopUiPreferencesApi,
  type DesktopPetPreferences,
} from '../../api/desktopUiPreferences'
import { sessionsApi, type PetSessionRuntimeStatus } from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { initializeDesktopServerUrl } from '../../lib/desktopRuntime'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { BUILTIN_PETS, findBuiltinPet } from './builtinPets'
import {
  getPetAnimationDurationMs,
  quantizePetLookDirection,
  type PetAnimationState,
  type PetLookDirection,
} from './petAnimation'
import { PetRenderer } from './PetRenderer'
import {
  buildPetSessionActivities,
  petStatusAnimation,
  type PetSessionStatus,
} from './petSessionModel'
import type { CustomPet, PetDescriptor } from './types'

const OBSERVED_SESSION_LIMIT = 9
const SESSION_REFRESH_INTERVAL_MS = 5_000
const STATUS_REFRESH_INTERVAL_MS = 2_000
const CUSTOM_PET_REFRESH_INTERVAL_MS = 30_000
const PET_DRAG_THRESHOLD_PX = 4

type PetDragGesture = {
  pointerId: number
  startScreenX: number
  startScreenY: number
  directionScreenX: number
  lastScreenX: number
  lastScreenY: number
  startPromise: Promise<void> | null
}

function toCustomPets(result: Awaited<ReturnType<ReturnType<typeof getDesktopHost>['pets']['list']>>): CustomPet[] {
  return result.pets.map((pet) => ({ source: 'custom' as const, ...pet }))
}

function statusDotClass(status: PetSessionStatus): string {
  switch (status) {
    case 'waiting': return 'is-waiting'
    case 'failed': return 'is-failed'
    case 'review': return 'is-review'
    case 'running': return 'is-running'
    case 'idle': return 'is-idle'
  }
}

export function PetApp() {
  const t = useTranslation()
  const sessions = useSessionStore((state) => state.sessions)
  const chats = useChatStore((state) => state.sessions)
  const [preferences, setPreferences] = useState<DesktopPetPreferences | null>(null)
  const [customPets, setCustomPets] = useState<CustomPet[]>([])
  const [observedStatuses, setObservedStatuses] = useState<Record<string, PetSessionRuntimeStatus>>({})
  const [startupError, setStartupError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [transientState, setTransientState] = useState<PetAnimationState | null>(null)
  const [isMascotDragging, setIsMascotDragging] = useState(false)
  const [dragDirection, setDragDirection] = useState<'left' | 'right' | null>(null)
  const [lookDirection, setLookDirection] = useState<PetLookDirection | null | undefined>(undefined)
  const preferencesRef = useRef<DesktopPetPreferences | null>(null)
  const pendingPreferencePatchesRef = useRef(new Map<number, Partial<DesktopPetPreferences>>())
  const nextPreferencePatchIdRef = useRef(0)
  const attemptedMissingCustomIdRef = useRef<string | null>(null)
  const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stackRef = useRef<HTMLDivElement | null>(null)
  const mascotRef = useRef<HTMLButtonElement | null>(null)
  const taskBadgeRef = useRef<HTMLButtonElement | null>(null)
  const activityCardRef = useRef<HTMLElement | null>(null)
  const panelToggleRef = useRef<HTMLButtonElement | null>(null)
  const dragGestureRef = useRef<PetDragGesture | null>(null)
  const suppressNextMascotClickRef = useRef(false)
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await initializeDesktopServerUrl()
        const [preferenceResult, customResult] = await Promise.all([
          desktopUiPreferencesApi.getPetPreferences(),
          getDesktopHost().pets.list(),
        ])
        if (cancelled) return
        const petPreferences = preferenceResult.pet
        preferencesRef.current = petPreferences
        setPreferences(petPreferences)
        setCustomPets(toCustomPets(customResult))
        await useSessionStore.getState().fetchSessions()
      } catch (error) {
        if (!cancelled) {
          setStartupError(error instanceof Error ? error.message : String(error))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const persistPreferences = useCallback(async (patch: Partial<DesktopPetPreferences>) => {
    const current = preferencesRef.current
    if (!current) return false

    const requestId = ++nextPreferencePatchIdRef.current
    pendingPreferencePatchesRef.current.set(requestId, patch)
    const next = { ...current, ...patch }
    preferencesRef.current = next
    setPreferences(next)
    try {
      await desktopUiPreferencesApi.updatePetPreferences(patch)
      return true
    } catch {
      // The next preference refresh reconciles a rejected optimistic update.
      return false
    } finally {
      pendingPreferencePatchesRef.current.delete(requestId)
    }
  }, [])

  useEffect(() => {
    if (!preferences) return
    let cancelled = false
    const refresh = async () => {
      try {
        const { pet: nextPetPreferences } = await desktopUiPreferencesApi.getPetPreferences()
        if (cancelled) return
        let nextPet = nextPetPreferences
        for (const pendingPatch of pendingPreferencePatchesRef.current.values()) {
          nextPet = { ...nextPet, ...pendingPatch }
        }
        preferencesRef.current = nextPet
        setPreferences(nextPet)
      } catch {
        // Settings remain usable with the last known local preferences.
      }
    }
    const timer = setInterval(() => void refresh(), 1_500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [preferences !== null])

  useEffect(() => {
    if (!preferences) return
    let cancelled = false
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        await useSessionStore.getState().fetchSessions()
      } finally {
        inFlight = false
      }
    }
    const timer = setInterval(() => void refresh(), SESSION_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
      void cancelled
    }
  }, [preferences !== null])

  useEffect(() => {
    if (!preferences) return
    let cancelled = false
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await getDesktopHost().pets.list()
        if (!cancelled) setCustomPets(toCustomPets(result))
      } catch {
        // Keep the last validated catalog while a package is being replaced.
      } finally {
        inFlight = false
      }
    }
    const timer = setInterval(() => void refresh(), CUSTOM_PET_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [preferences !== null])

  useEffect(() => {
    const selectedPetId = preferences?.selectedPetId
    if (!selectedPetId?.startsWith('custom:')) {
      attemptedMissingCustomIdRef.current = null
      return
    }
    if (customPets.some((pet) => pet.id === selectedPetId)) {
      attemptedMissingCustomIdRef.current = null
      return
    }
    if (attemptedMissingCustomIdRef.current === selectedPetId) return

    attemptedMissingCustomIdRef.current = selectedPetId
    let cancelled = false
    void getDesktopHost().pets.list()
      .then((result) => {
        if (cancelled) return
        const nextPets = toCustomPets(result)
        setCustomPets(nextPets)
        if (!nextPets.some((pet) => pet.id === selectedPetId)) {
          void persistPreferences({ selectedPetId: BUILTIN_PETS[0]!.id })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [customPets, persistPreferences, preferences?.selectedPetId])

  const observedSessions = useMemo(
    () => [...sessions]
      .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
      .slice(0, OBSERVED_SESSION_LIMIT),
    [sessions],
  )
  const observedSessionKey = observedSessions.map((session) => session.id).join('\u0000')

  useEffect(() => {
    if (!observedSessionKey) {
      setObservedStatuses({})
      return
    }

    let cancelled = false
    let inFlight = false
    const controller = new AbortController()
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const results = await Promise.all(observedSessions.map(async (session) => {
          try {
            const result = await sessionsApi.getChatStatus(session.id, controller.signal)
            return [session.id, result.activityState] as const
          } catch {
            return [session.id, null] as const
          }
        }))
        if (cancelled) return
        setObservedStatuses((current) => Object.fromEntries(results.map(([sessionId, status]) => [
          sessionId,
          status ?? current[sessionId] ?? 'idle',
        ])))
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), STATUS_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [observedSessionKey, observedSessions])

  const activities = useMemo(() => buildPetSessionActivities({
    sessions: observedSessions,
    chats,
    observedStatuses,
    limit: OBSERVED_SESSION_LIMIT,
  }).filter((activity) => activity.status !== 'idle'), [chats, observedSessions, observedStatuses])

  useEffect(() => () => {
    if (transientTimerRef.current) clearTimeout(transientTimerRef.current)
    if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current)
    void getDesktopHost().pets.setIgnoreMouseEvents(true)
  }, [])

  const playTransient = useCallback((state: PetAnimationState) => {
    if (transientTimerRef.current) clearTimeout(transientTimerRef.current)
    setTransientState(state)
    transientTimerRef.current = setTimeout(() => {
      setTransientState(null)
      transientTimerRef.current = null
    }, getPetAnimationDurationMs(state) * 3)
  }, [])

  const closePet = useCallback(async () => {
    const persisted = await persistPreferences({ enabled: false })
    if (!persisted) {
      setActionError(t('pet.window.saveError'))
      return
    }
    setActionError(null)
    try {
      await getDesktopHost().pets.hide()
    } catch {
      await persistPreferences({ enabled: true })
      setActionError(t('pet.window.closeError'))
    }
  }, [persistPreferences, t])

  const primaryActivity = activities[0]
  const baseAnimation = primaryActivity ? petStatusAnimation(primaryActivity.status) : 'idle'
  const animationState = dragDirection
    ? `running-${dragDirection}` as const
    : transientState ?? baseAnimation
  const allPets: readonly PetDescriptor[] = [...BUILTIN_PETS, ...customPets]
  const selectedPet = allPets.find((pet) => pet.id === preferences?.selectedPetId)
    ?? findBuiltinPet(preferences?.selectedPetId ?? '')
  const showActivityCard = Boolean(actionError)
    || Boolean(preferences?.showTaskPanel && activities.length > 0)
  const expanded = showActivityCard

  useLayoutEffect(() => {
    if (!preferences) return
    const elements = [
      mascotRef.current,
      taskBadgeRef.current,
      activityCardRef.current,
      panelToggleRef.current,
    ]
    const targets = elements.filter((element) => element !== null) as HTMLElement[]
    const updateRegions = () => {
      const regions = targets.map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(1, Math.ceil(rect.width)),
          height: Math.max(1, Math.ceil(rect.height)),
        }
      })
      if (regions.length > 0) void getDesktopHost().pets.setInteractiveRegions(regions)
    }

    updateRegions()
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateRegions)
    targets.forEach((target) => observer?.observe(target))
    window.addEventListener('resize', updateRegions)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateRegions)
    }
  }, [activities.length, expanded, preferences?.size, selectedPet, showActivityCard])

  const isInteractivePoint = useCallback((x: number, y: number) => [
    mascotRef.current,
    taskBadgeRef.current,
    activityCardRef.current,
    panelToggleRef.current,
  ].some((element) => {
    if (!element) return false
    const rect = element.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }), [])

  const finishMascotDrag = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    releaseCapture: boolean,
  ) => {
    const gesture = dragGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const x = Number.isFinite(event.screenX) ? event.screenX : gesture.lastScreenX
    const y = Number.isFinite(event.screenY) ? event.screenY : gesture.lastScreenY
    const wasDragging = gesture.startPromise !== null
    dragGestureRef.current = null
    setIsMascotDragging(false)
    setDragDirection(null)

    if (wasDragging && gesture.startPromise) {
      event.preventDefault()
      suppressNextMascotClickRef.current = true
      if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current)
      suppressClickTimerRef.current = setTimeout(() => {
        suppressNextMascotClickRef.current = false
        suppressClickTimerRef.current = null
      }, 0)
      void gesture.startPromise
        .then(() => getDesktopHost().pets.dragWindow({ phase: 'end', x, y }))
        .catch(() => undefined)
    }

    if (releaseCapture) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      } catch {
        // The browser may release capture first when a pointer is cancelled.
      }
    }
    if (!isInteractivePoint(event.clientX, event.clientY)) {
      setLookDirection(undefined)
      void getDesktopHost().pets.setIgnoreMouseEvents(true)
    }
  }, [isInteractivePoint])

  const releasePointerPassthrough = useCallback((nextTarget: EventTarget | null) => {
    if (dragGestureRef.current) return
    const nextNode = typeof Node !== 'undefined' && nextTarget instanceof Node
      ? nextTarget
      : null
    const remainsInteractive = nextNode !== null && [
      mascotRef.current,
      taskBadgeRef.current,
      activityCardRef.current,
      panelToggleRef.current,
    ].some((element) => element?.contains(nextNode))
    if (remainsInteractive) return

    setLookDirection(undefined)
    void getDesktopHost().pets.setIgnoreMouseEvents(true)
  }, [])

  if (startupError) {
    return (
      <main className="pet-window-root">
        <div role="alert" className="pet-error-card">{startupError}</div>
      </main>
    )
  }

  if (!preferences) {
    return <main className="pet-window-root" aria-busy="true" />
  }

  return (
    <main
      className="pet-window-root"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div
        ref={stackRef}
        className="pet-window-stack"
        onMouseEnter={() => void getDesktopHost().pets.setIgnoreMouseEvents(false)}
        onMouseMove={(event) => {
          if (dragGestureRef.current) return
          if (animationState !== 'idle') return
          const rect = mascotRef.current?.getBoundingClientRect()
          if (!rect) return
          setLookDirection(quantizePetLookDirection(
            event.clientX - (rect.left + rect.width / 2),
            event.clientY - (rect.top + rect.height / 2),
            12,
          ))
        }}
        onMouseLeave={() => {
          if (dragGestureRef.current) return
          setLookDirection(undefined)
          void getDesktopHost().pets.setIgnoreMouseEvents(true)
        }}
      >
        <div className="pet-mascot-wrap">
          <button
            ref={mascotRef}
            type="button"
            className="pet-mascot-button"
            data-dragging={isMascotDragging ? 'true' : 'false'}
            data-drag-direction={dragDirection ?? undefined}
            aria-label={t('pet.window.interact')}
            onMouseEnter={() => {
              void getDesktopHost().pets.setIgnoreMouseEvents(false)
              if (!dragGestureRef.current && animationState === 'idle') {
                playTransient('jumping')
              }
            }}
            onClick={() => {
              if (suppressNextMascotClickRef.current) {
                suppressNextMascotClickRef.current = false
                if (suppressClickTimerRef.current) {
                  clearTimeout(suppressClickTimerRef.current)
                  suppressClickTimerRef.current = null
                }
                return
              }
              playTransient('waving')
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void getDesktopHost().pets.showContextMenu(t('pet.window.close'))
                .then((shouldClose) => {
                  if (shouldClose) void closePet()
                })
                .catch(() => setActionError(t('pet.window.closeError')))
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.isPrimary === false || dragGestureRef.current) return
              suppressNextMascotClickRef.current = false
              if (suppressClickTimerRef.current) {
                clearTimeout(suppressClickTimerRef.current)
                suppressClickTimerRef.current = null
              }
              dragGestureRef.current = {
                pointerId: event.pointerId,
                startScreenX: event.screenX,
                startScreenY: event.screenY,
                directionScreenX: event.screenX,
                lastScreenX: event.screenX,
                lastScreenY: event.screenY,
                startPromise: null,
              }
              void getDesktopHost().pets.setIgnoreMouseEvents(false)
              try {
                event.currentTarget.setPointerCapture(event.pointerId)
              } catch {
                // Pointer capture can fail when the pointer has already been cancelled.
              }
            }}
            onPointerMove={(event) => {
              const gesture = dragGestureRef.current
              if (!gesture || gesture.pointerId !== event.pointerId || (event.buttons & 1) === 0) return
              gesture.lastScreenX = event.screenX
              gesture.lastScreenY = event.screenY
              if (!gesture.startPromise) {
                const distance = Math.hypot(
                  event.screenX - gesture.startScreenX,
                  event.screenY - gesture.startScreenY,
                )
                if (distance < PET_DRAG_THRESHOLD_PX) return
                suppressNextMascotClickRef.current = true
                setIsMascotDragging(true)
                gesture.startPromise = Promise.resolve().then(() =>
                  getDesktopHost().pets.dragWindow({
                    phase: 'start',
                    x: gesture.startScreenX,
                    y: gesture.startScreenY,
                  }))
                void gesture.startPromise.catch(() => undefined)
              }
              const directionDelta = event.screenX - gesture.directionScreenX
              if (Math.abs(directionDelta) >= PET_DRAG_THRESHOLD_PX) {
                setDragDirection(directionDelta < 0 ? 'left' : 'right')
                gesture.directionScreenX = event.screenX
              }
              event.preventDefault()
            }}
            onPointerUp={(event) => finishMascotDrag(event, true)}
            onPointerCancel={(event) => finishMascotDrag(event, true)}
            onLostPointerCapture={(event) => finishMascotDrag(event, false)}
            onMouseLeave={(event) => releasePointerPassthrough(event.relatedTarget)}
          >
            <PetRenderer
              pet={selectedPet}
              state={animationState}
              size={preferences.size}
              motionEnabled={preferences.motionEnabled}
              lookDirection={animationState === 'idle'
                ? lookDirection
                : undefined}
            />
          </button>
          {activities.length > 0 && !showActivityCard && (
            <button
              ref={taskBadgeRef}
              type="button"
              className="pet-task-badge"
              aria-label={t('pet.window.expandTasks', { count: activities.length })}
              onMouseEnter={() => void getDesktopHost().pets.setIgnoreMouseEvents(false)}
              onMouseLeave={(event) => releasePointerPassthrough(event.relatedTarget)}
              onClick={() => void persistPreferences({ showTaskPanel: true })}
            >
              {activities.length}
            </button>
          )}
        </div>

        {showActivityCard && (
          <section
            ref={activityCardRef}
            className="pet-activity-card"
            data-expanded={expanded ? 'true' : 'false'}
            aria-label={t('pet.window.sessionCount', { count: activities.length })}
            onMouseEnter={() => void getDesktopHost().pets.setIgnoreMouseEvents(false)}
            onMouseLeave={(event) => releasePointerPassthrough(event.relatedTarget)}
          >
            {actionError && (
              <p role="alert" className="mx-3 mt-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">
                {actionError}
              </p>
            )}

            <div
              className="pet-session-list"
              data-expanded={expanded ? 'true' : 'false'}
              role="list"
              aria-live="polite"
              aria-label={t('pet.window.sessionCount', { count: activities.length })}
            >
              {activities.map((activity) => {
                const title = activity.session.title || t('pet.window.untitledSession')
                const status = t(`pet.window.status.${activity.status}` as Parameters<typeof t>[0])
                return (
                  <div
                    role="listitem"
                    key={activity.session.id}
                  >
                    <button
                      type="button"
                      className="pet-session-row"
                      aria-label={`${title}, ${status}`}
                      onClick={() => void getDesktopHost().pets.focusSession(activity.session.id)}
                    >
                      <span className="pet-session-copy">
                        <span className="pet-session-title">{title}</span>
                        <span className="pet-session-status">{status}</span>
                      </span>
                      <span className={`pet-session-indicator ${statusDotClass(activity.status)}`} />
                    </button>
                  </div>
                )
              })}
            </div>

            <button
              ref={panelToggleRef}
              type="button"
              className="pet-panel-toggle"
              data-expanded={expanded ? 'true' : 'false'}
              aria-label={t('pet.window.hideTasks', { count: activities.length })}
              onClick={() => {
                setActionError(null)
                void persistPreferences({ showTaskPanel: false })
              }}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </section>
        )}
      </div>
    </main>
  )
}
