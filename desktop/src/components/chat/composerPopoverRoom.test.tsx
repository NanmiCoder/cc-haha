import type { ReactElement } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

import { sessionCollaborationApi } from '@/api/sessionCollaboration'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import { ComposerCapabilityMenu } from './ComposerCapabilityMenu'
import { ComposerReferenceMenu } from './ComposerReferenceMenu'
import { LocalSlashCommandPanel } from './LocalSlashCommandPanel'
import { SlashCommandMenu } from './SlashCommandMenu'
import type { CapabilityMenuSection } from './capabilityMenuModel'
import type { SlashCommandOption } from './composerUtils'

vi.mock('@/api/sessionCollaboration', () => ({ sessionCollaborationApi: { list: vi.fn() } }))
vi.mock('@/api/filesystem', () => ({ filesystemApi: { browse: vi.fn(), search: vi.fn() } }))

/**
 * Every composer popover opens upward (`bottom-full`) from the composer card.
 * Their `vh` caps assumed the composer sits at the bottom of the window; a new
 * session centres it inside a page that clips its overflow, and the slash menu
 * ran 143px past the page top in a 1188×751 window (#1587). Each one now caps
 * itself at the room above the composer.
 *
 * jsdom has no layout, so the geometry of that window is stubbed: the page
 * starts under the 52px tab bar, and each popover's bottom edge sits at 306px.
 */
const PAGE_TOP = 52
const POPOVER_BOTTOM = 306
const ROOM = POPOVER_BOTTOM - PAGE_TOP - 8

const originalRect = HTMLElement.prototype.getBoundingClientRect
const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

beforeEach(() => {
  vi.mocked(sessionCollaborationApi.list).mockResolvedValue({ sessions: [] })
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    const box = this.dataset.testid === 'page'
      ? { top: PAGE_TOP, bottom: 751 }
      : this.parentElement?.dataset.testid === 'composer'
        ? { top: 0, bottom: POPOVER_BOTTOM }
        : {}
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...box } as DOMRect
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement?.closest('[data-testid="composer"]') ?? null
    },
  })
})

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect
  if (originalOffsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent)
  else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
})

const commands: SlashCommandOption[] = Array.from({ length: 12 }, (_, index) => ({
  name: `command-${index}`,
  description: `Command ${index}`,
  kind: 'command',
}))

const references: ComposerReferenceCandidate[] = Array.from({ length: 12 }, (_, index) => ({
  kind: 'skill',
  id: `skill-${index}`,
  name: `skill-${index}`,
  displayName: `Skill ${index}`,
  description: 'A skill',
  source: 'user',
  modelText: `Use skill ${index}`,
}))

const sections: CapabilityMenuSection[] = [{
  id: 'use',
  title: 'For this task',
  showTitle: true,
  items: Array.from({ length: 6 }, (_, index) => ({
    key: `item-${index}`,
    label: `Item ${index}`,
    icon: { kind: 'slash' as const },
    action: { type: 'market' as const, section: 'skills' as const },
  })),
}]

/** Renders a popover the way both composers do: inside the card, inside a page that clips. */
function renderInComposer(popover: ReactElement) {
  render(
    <div data-testid="page" style={{ overflowY: 'hidden' }}>
      <div data-testid="composer">{popover}</div>
    </div>,
  )
  return screen.getByTestId('composer').firstElementChild as HTMLElement
}

describe('composer popovers above a centred composer', () => {
  const surfaces: Array<{ name: string; render: () => HTMLElement }> = [
    {
      name: 'slash command menu',
      render: () => renderInComposer(
        <SlashCommandMenu
          id="slash"
          groups={{ system: commands, skills: [], ordered: [] }}
          selectedIndex={0}
          itemRefs={{ current: [] }}
          onSelect={vi.fn()}
          onHighlight={vi.fn()}
          showKeyboardHints
        />,
      ),
    },
    {
      name: '@ reference menu',
      render: () => renderInComposer(
        <ComposerReferenceMenu id="references" cwd="/work" references={references} onSelect={vi.fn()} />,
      ),
    },
    {
      name: 'local command panel (/help)',
      render: () => renderInComposer(<LocalSlashCommandPanel command="help" commands={commands} onClose={vi.fn()} />),
    },
    {
      name: 'session inspector (/status)',
      render: () => renderInComposer(<LocalSlashCommandPanel command="status" commands={commands} onClose={vi.fn()} />),
    },
    {
      // Beside-the-menu layout: the wrapper is measured, the root panel is capped.
      name: '+ menu',
      render: () => renderInComposer(
        <ComposerCapabilityMenu id="capabilities" sections={sections} onAction={vi.fn()} onClose={vi.fn()} />,
      ).firstElementChild as HTMLElement,
    },
  ]

  for (const surface of surfaces) {
    it(`caps the ${surface.name} at the room above the composer`, () => {
      const popover = surface.render()

      expect(popover.style.maxHeight).toBe(`${ROOM}px`)
      // The cap only helps if the scrolling body is what gives way: a column
      // flex box lets it shrink while the header and key hints keep their size.
      expect(popover).toHaveClass('flex', 'flex-col')
    })
  }
})
