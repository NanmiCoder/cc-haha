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
 * Every popover above the composer row (「素」: model, effort, permission
 * mode, the + menu, slash commands, references, context) is a menu sheet at
 * the card corner, `--radius-lg`; only the composer card itself is `xl`. The
 * shared recipe lives in `composerMenuStyles.ts`, so a component may either
 * use `COMPOSER_POPOVER` or spell the panel inline — both are held here.
 */
const OVERLAY_RADIUS = 'rounded-[var(--radius-lg)]'

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
const MENU_STYLES = source('./composerMenuStyles.ts')

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

      const sharedRecipeUses = (code.match(/\bCOMPOSER_POPOVER\b/g) ?? []).length
      expect(panels.length + sharedRecipeUses).toBeGreaterThan(0)
      for (const panel of panels) {
        expect(panel, `${name} renders a panel at a corner other than ${OVERLAY_RADIUS}`)
          .toContain(OVERLAY_RADIUS)
      }
    })
  }

  it('holds the shared popover recipe to the same corner, edge and fill', () => {
    const recipe = /export const COMPOSER_POPOVER =\s*'([^']+)'/.exec(MENU_STYLES)?.[1] ?? ''
    for (const token of [OVERLAY_RADIUS, 'border-[var(--color-border)]', 'bg-[var(--color-surface-container-lowest)]', 'shadow-[var(--shadow-dropdown)]']) {
      expect(recipe).toContain(token)
    }
  })

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
