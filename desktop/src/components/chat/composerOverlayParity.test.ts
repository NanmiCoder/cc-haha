import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The zero-state composer (`pages/EmptySession`) and the session composer
 * (`components/chat/ChatInput`) are two implementations of one control. The
 * user sees the same slash menu and the same plus menu in both, so the two
 * copies drifting is invisible in either file on its own — the slash menu
 * shipped at `--radius-lg` in one and `--radius-xl` in the other, and only a
 * walkthrough that opened both in the same session caught it.
 *
 * The panels above the composer row that the handoff specced directly (the
 * context, effort, branch and worktree popovers) all sit at the card step, so
 * that is the corner the whole composer stack is held to here.
 */
const OVERLAY_RADIUS = 'rounded-[var(--radius-xl)]'

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const COMPOSERS = {
  ChatInput: source('./ChatInput.tsx'),
  EmptySession: source('../../pages/EmptySession.tsx'),
  PermissionModeSelector: source('../controls/PermissionModeSelector.tsx'),
  ModelSelector: source('../controls/ModelSelector.tsx'),
  ComposerCapabilityMenu: source('./ComposerCapabilityMenu.tsx'),
}
const SLASH_COMMAND_MENU = source('./SlashCommandMenu.tsx')

/** Every className string that also carries a floating-panel background. */
function overlayPanelClassNames(code: string): string[] {
  return code
    .split('\n')
    .filter((line) => line.includes('bg-[var(--color-surface-container-lowest)]'))
    .filter((line) => /\brounded-\[var\(--radius-/.test(line))
}

describe('composer overlay chrome', () => {
  for (const [name, code] of Object.entries(COMPOSERS)) {
    it(`keeps every floating panel in ${name} at the card corner`, () => {
      const panels = overlayPanelClassNames(code)
      // The two composers delegate their overlays to shared components: any
      // inline panel in them is a regression toward the duplicated chrome this
      // file exists to prevent.
      if (name === 'ChatInput' || name === 'EmptySession') {
        expect(panels, `${name} should not render inline overlay panels; use the shared components`).toEqual([])
        return
      }

      expect(panels.length).toBeGreaterThan(0)
      for (const panel of panels) {
        expect(panel, `${name} renders a panel at a corner other than ${OVERLAY_RADIUS}`)
          .toContain(OVERLAY_RADIUS)
      }
    })
  }

  it('renders the same slash menu and capability menu in both composers', () => {
    for (const [name, code] of Object.entries({
      ChatInput: COMPOSERS.ChatInput,
      EmptySession: COMPOSERS.EmptySession,
    })) {
      expect(code, `${name} must render the shared slash menu`).toContain('<SlashCommandMenu')
      expect(code, `${name} must render the shared capability menu`).toContain('<ComposerCapabilityMenu')
      expect(code, `${name} must build capability sections through the shared hook`).toContain('useCapabilityMenu')
    }

    for (const token of [OVERLAY_RADIUS, 'border-[var(--color-border)]', 'bg-[var(--color-surface-container-lowest)]']) {
      expect(SLASH_COMMAND_MENU).toContain(token)
      expect(COMPOSERS.ComposerCapabilityMenu).toContain(token)
    }
  })
})
