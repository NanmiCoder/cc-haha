import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { CodeViewer } from './CodeViewer'
import { useSettingsStore } from '../../stores/settingsStore'

describe('CodeViewer', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('translates its line count and copy action', () => {
    // Regression: the header spelled "3 lines" and the copy button "Copy" in
    // English whatever the interface language was.
    useSettingsStore.setState({ locale: 'zh' })
    render(<CodeViewer code={'{\n  "a": 1\n}'} language="json" />)

    expect(screen.getByText('3 行')).toBeTruthy()
    expect(screen.queryByText(/lines?$/)).toBeNull()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('heads the block with one quiet 30px line: language in mono, no uppercase tracking, a labelled ghost copy', () => {
    const { container } = render(<CodeViewer code={'const a = 1'} language="ts" label="Input" />)
    const header = container.querySelector('[data-code-viewer-chrome] > div') as HTMLElement
    expect(header.className).toContain('h-[30px]')
    expect(container.innerHTML).not.toMatch(/\buppercase\b|tracking-\[/)
    expect(screen.getByText('ts').className).toContain('font-mono')
    const copy = screen.getByRole('button', { name: 'Copy' })
    // The icon is decoration; the word is what the button says.
    expect(copy.textContent).toBe('Copy')
    expect(copy.querySelector('svg.lucide-copy')).not.toBeNull()
    expect(copy.className.split(/\s+/)).not.toContain('border')
    // The card is a code block, so it takes the 8px block radius.
    expect((container.firstElementChild as HTMLElement).className).toContain('rounded-[var(--radius-md)]')
  })

  it('counts a single line in the singular', () => {
    render(<CodeViewer code="ls" language="bash" />)
    expect(screen.getByText('1 line')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('keeps the same inner padding for highlighted code content', () => {
    const { container } = render(
      <CodeViewer code={'cd testb\nnpm run dev'} language="bash" showLineNumbers />,
    )

    expect(screen.getByText('cd testb')).toBeTruthy()
    expect(screen.getByText('npm run dev')).toBeTruthy()

    const contentWrapper = container.querySelector('[data-code-viewer-content]') as HTMLElement | null
    expect(contentWrapper).toBeTruthy()
    // Vertical only: the horizontal gutter is on each line (globals.css), the
    // same for Prism and Shiki, so a hovered line spans the full width.
    expect(contentWrapper?.style.padding).toBe('10px 0px 12px')
    expect(contentWrapper?.style.whiteSpace).toBe('pre')
    expect(contentWrapper?.style.wordBreak).toBe('normal')
    expect(contentWrapper?.style.fontSize).toBe('var(--code-viewer-font-size, 13px)')
    expect(contentWrapper?.style.fontFamily).toBe('var(--font-mono)')
    // Reading preferences resize code content, while the toolbar retains UI typography.
    expect((container.firstElementChild as HTMLElement).style.fontFamily).toBe('var(--font-body)')

    const codeArea = container.querySelector('.code-viewer-area') as HTMLElement | null
    expect(codeArea?.getAttribute('data-has-line-numbers')).toBe('true')
    expect(container.querySelector('[data-line-number="1"]')).toBeTruthy()
    expect(container.querySelector('[data-line-number="2"]')).toBeTruthy()
  })

  it('can wrap long highlighted code content when requested', () => {
    const { container } = render(
      <CodeViewer code={'{"command":"cat << EOF > /tmp/index.html"}'} language="json" wrapLongLines />,
    )

    const contentWrapper = container.querySelector('[data-code-viewer-content]') as HTMLElement | null
    expect(contentWrapper).toBeTruthy()
    expect(contentWrapper?.style.whiteSpace).toBe('pre-wrap')
    expect(contentWrapper?.style.wordBreak).toBe('break-word')
  })
  it("caps the code area by default, so a tool card cannot take over the chat", () => {
    const { container } = render(<CodeViewer code={"a\nb"} language="json" />)
    expect(container.querySelector(".code-viewer-area")?.className).toContain("max-h-[420px]")
  })

  it("lets a host that already scrolls grow the code area with its content", () => {
    // Regression: inside the trajectory detail panel the 420px box scrolled on
    // its own and left the rest of the panel empty below it.
    const { container } = render(<CodeViewer code={"a\nb"} language="json" unboundedHeight />)
    const area = container.querySelector(".code-viewer-area")
    expect(area?.className).not.toContain("max-h-")
    expect(area?.getAttribute("data-unbounded-height")).toBe("true")
  })
})
