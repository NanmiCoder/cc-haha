import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { agentsApi } from '@/api/agents'
import { composerReferencesApi, mentionProviderId } from '@/api/composerReferences'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '@/i18n'
import { isLeanSlashCommand } from '@/lib/agentProfile'
import { isComposerReferenceVisible, isComposerSlashCommandVisible } from '@/lib/composerCapabilityVisibility'
import {
  composerReferenceToMention,
  findMentionRanges,
  insertMentionIntoText,
  type ComposerMention,
} from '@/lib/composerMentions'
import { useCapabilityCatalogStore } from '@/stores/capabilityCatalogStore'
import { useChatStore } from '@/stores/chatStore'
import { useSessionRuntimeStore } from '@/stores/sessionRuntimeStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { ComposerReferenceMenu, type ComposerReferenceMenuHandle } from './ComposerReferenceMenu'
import {
  appendAgentSlashCommands,
  buildAgentSlashCommands,
  filterSlashCommands,
  findSlashTrigger,
  getLocalizedFallbackCommands,
  groupSlashCommands,
  mergeSlashCommands,
  replaceSlashToken,
  resolveSlashUiAction,
} from './composerUtils'
import type { MentionComposerHandle } from './MentionComposer'
import { getSlashCommandOptionId, SlashCommandMenu } from './SlashCommandMenu'

const EMPTY_COMMANDS: NonNullable<ReturnType<typeof useChatStore.getState>['sessions'][string]>['slashCommands'] = []

type ReferenceState = { items: ComposerReferenceCandidate[], loading: boolean, error: boolean }

type Options = {
  sessionId: string | undefined
  text: string
  mentions: ComposerMention[]
  composerRef: RefObject<MentionComposerHandle>
  /** The card the menus attach to; clicks inside it are not "outside". */
  containerRef: RefObject<HTMLDivElement>
  onChange: (text: string, mentions: ComposerMention[]) => void
}

/**
 * `/` and `@` in the message editor, the way the composer has them: a slash
 * command is plain text that stays in the prompt, a skill or plugin becomes a
 * pill. Only what a resent prompt can carry is offered — the composer's own UI
 * commands (/model, panels, settings) act on the composer, so they are left out.
 * `@` here picks skills and plugins; files travel as the editor's attachments.
 */
export function useEditorCapabilityTriggers({ sessionId, text, mentions, composerRef, containerRef, onChange }: Options) {
  const t = useTranslation()
  const menuId = useId()
  const referenceMenuId = `${menuId}-reference`
  const session = useSessionStore((state) => sessionId ? state.sessions.find((item) => item.id === sessionId) : undefined)
  const workDir = session?.workDir ?? ''
  const isLean = session?.agentProfile === 'lean'
  const sessionCommands = useChatStore((state) => sessionId ? state.sessions[sessionId]?.slashCommands : undefined) ?? EMPTY_COMMANDS
  const providerId = useSessionRuntimeStore((state) => sessionId ? mentionProviderId(state.selections[sessionId]) : undefined)

  const [slashOpen, setSlashOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [atOpen, setAtOpen] = useState(false)
  const [atFilter, setAtFilter] = useState('')
  const [atPos, setAtPos] = useState(-1)
  const [references, setReferences] = useState<ReferenceState>({ items: [], loading: false, error: false })
  const [agentCommands, setAgentCommands] = useState<ReturnType<typeof buildAgentSlashCommands>>([])
  const [referenceOptionId, setReferenceOptionId] = useState<string | undefined>()
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const slashItemRefs = useRef<(HTMLElement | null)[]>([])
  const referenceMenuRef = useRef<ComposerReferenceMenuHandle>(null)

  // Fetched when a menu opens, not when the editor does: most edits fix a typo.
  const menuOpen = slashOpen || atOpen
  useEffect(() => {
    if (!menuOpen) return
    let active = true
    setReferences((current) => ({ ...current, loading: true, error: false }))
    void composerReferencesApi.list(workDir || undefined, providerId, isLean ? 'lean' : undefined).then((data) => {
      useCapabilityCatalogStore.getState().remember([...data.plugins, ...data.skills])
      if (active) setReferences({ items: [...data.plugins, ...data.skills], loading: false, error: false })
    }).catch(() => {
      if (active) setReferences({ items: [], loading: false, error: true })
    })
    agentsApi.list(workDir || undefined)
      .then(({ activeAgents }) => { if (active) setAgentCommands(buildAgentSlashCommands(activeAgents)) })
      .catch(() => { if (active) setAgentCommands([]) })
    return () => { active = false }
  }, [menuOpen, workDir, providerId, isLean])

  const visibleReferences = useMemo(
    () => references.items.filter((reference) => isComposerReferenceVisible(reference) && (!isLean || reference.kind === 'skill')),
    [references.items, isLean],
  )

  const commands = useMemo(() => {
    const listed = new Set(sessionCommands.map((command) => command.name))
    const merged = appendAgentSlashCommands(mergeSlashCommands(sessionCommands, getLocalizedFallbackCommands(t)), agentCommands)
    const names = new Set(merged.map((command) => command.name.toLowerCase()))
    for (const reference of visibleReferences) {
      const name = reference.kind === 'plugin' ? reference.id : reference.name
      if (names.has(name.toLowerCase())) continue
      names.add(name.toLowerCase())
      merged.push({ name, description: reference.description, kind: reference.kind })
    }
    return merged.filter((command) =>
      isComposerSlashCommandVisible(command) &&
      !resolveSlashUiAction(command.name) &&
      // `/btw` is turned into a side chat by the main composer before any runtime
      // sees it; an edit resend has no such interception and would send it as text.
      command.name !== 'btw' &&
      (!isLean || isLeanSlashCommand(command, listed)))
  }, [agentCommands, isLean, sessionCommands, t, visibleReferences])

  const groups = useMemo(() => groupSlashCommands(filterSlashCommands(commands, slashFilter)), [commands, slashFilter])
  const slashVisible = slashOpen && groups.ordered.length > 0
  useEffect(() => { setSlashIndex(0) }, [slashFilter])
  useEffect(() => {
    const active = slashOpen ? slashItemRefs.current[slashIndex] : null
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' })
  }, [slashOpen, slashIndex])

  const closeMenus = useCallback(() => {
    setSlashOpen(false)
    setAtOpen(false)
    setAtFilter('')
    setAtPos(-1)
  }, [])

  useDismissable({
    open: slashOpen || atOpen,
    refs: [slashMenuRef, containerRef],
    onDismiss: closeMenus,
    isExempt: (target) => {
      const menu = document.getElementById(referenceMenuId)
      return target instanceof Node && Boolean(menu?.contains(target))
    },
  })

  const refocus = (cursor: number) => {
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionOffsets(cursor)
    })
  }

  const insertMention = (reference: ComposerReferenceCandidate, start: number, end: number) => {
    const inserted = insertMentionIntoText(text, mentions, start, end, composerReferenceToMention(reference))
    onChange(inserted.text, inserted.mentions)
    refocus(inserted.cursorPos)
  }

  const selectSlashCommand = (name: string) => {
    const cursor = composerRef.current?.getSelectionOffsets().start ?? text.length
    const option = commands.find((item) => item.name === name)
    const reference = (option?.kind === 'skill' || option?.kind === 'plugin')
      ? visibleReferences.find((item) => item.kind === option.kind && (item.id === name || item.name === name))
      : undefined
    if (reference) {
      const trigger = findSlashTrigger(text, cursor)
      insertMention(reference, trigger?.slashPos ?? cursor, cursor)
    } else {
      const replacement = replaceSlashToken(text, cursor, name)
      onChange(replacement.value, mentions)
      refocus(replacement.cursorPos)
    }
    closeMenus()
  }

  // Run after every edit, on the projected text: an `@` inside a pill is never a trigger.
  const detectTriggers = (value: string, nextMentions: ComposerMention[]) => {
    const cursor = composerRef.current?.getSelectionOffsets().start ?? value.length
    const slash = findSlashTrigger(value, cursor)
    if (slash) {
      setAtOpen(false)
      setSlashFilter(slash.filter)
      setSlashOpen(true)
      return
    }
    setSlashOpen(false)

    const before = value.slice(0, cursor)
    let pos = -1
    for (let index = before.length - 1; index >= 0; index -= 1) {
      const char = before[index]!
      if (char === '@') {
        if (index === 0 || /\s/.test(before[index - 1]!)) pos = index
        break
      }
      if (/\s/.test(char)) break
    }
    if (pos >= 0 && findMentionRanges(value, nextMentions).some((range) => pos >= range.start && pos < range.end)) pos = -1
    if (pos < 0) {
      setAtOpen(false)
      setAtFilter('')
      setAtPos(-1)
      return
    }
    setAtFilter(before.slice(pos + 1))
    setAtPos(pos)
    setAtOpen(true)
  }

  /** True when the key belonged to an open menu; the editor then ignores it. */
  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (atOpen) {
      const key = event.key
      if (key === 'Escape') {
        event.preventDefault()
        closeMenus()
        return true
      }
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === 'Tab') {
        event.preventDefault()
        referenceMenuRef.current?.handleKeyDown(event)
        return true
      }
      return false
    }
    if (!slashVisible) return false
    const count = groups.ordered.length
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSlashIndex((index) => (index + 1) % count)
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSlashIndex((index) => (index - 1 + count) % count)
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const selected = groups.ordered[slashIndex]
      if (selected) selectSlashCommand(selected.name)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenus()
      return true
    }
    return false
  }

  const menus: ReactNode = (
    <>
      {atOpen ? (
        <ComposerReferenceMenu
          ref={referenceMenuRef}
          id={referenceMenuId}
          cwd={workDir}
          filter={atFilter}
          browseReferences
          allowBelow
          references={visibleReferences}
          referencesLoading={references.loading}
          referencesError={references.error}
          onActiveChange={setReferenceOptionId}
          onSelect={(mention) => {
            if (atPos < 0) return
            const reference = visibleReferences.find((item) => item.kind === mention.kind && item.id === mention.id)
            if (!reference) return
            insertMention(reference, atPos, atPos + 1 + atFilter.length)
            closeMenus()
          }}
        />
      ) : null}
      {slashVisible ? (
        <SlashCommandMenu
          ref={slashMenuRef}
          id={menuId}
          isSearching={Boolean(slashFilter.trim())}
          groups={groups}
          references={visibleReferences}
          selectedIndex={slashIndex}
          itemRefs={slashItemRefs}
          onSelect={selectSlashCommand}
          onHighlight={setSlashIndex}
          showKeyboardHints
          allowBelow
        />
      ) : null}
    </>
  )

  const comboboxAria: Record<string, string | undefined> = atOpen || slashVisible
    ? {
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': 'true',
        'aria-controls': atOpen ? referenceMenuId : menuId,
        'aria-activedescendant': atOpen ? referenceOptionId : getSlashCommandOptionId(menuId, slashIndex),
      }
    : { role: 'textbox', 'aria-autocomplete': undefined, 'aria-expanded': undefined, 'aria-controls': undefined, 'aria-activedescendant': undefined }

  return { menus, comboboxAria, handleKeyDown, detectTriggers, menuOpen: atOpen || slashVisible }
}
