import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeViewer } from './CodeViewer'

const mockShikiState = vi.hoisted(() => ({
  lastProps: null as Record<string, unknown> | null,
  engine: { kind: 'js-regex-engine' as const },
}))

vi.mock('react-shiki', () => ({
  createJavaScriptRegexEngine: () => mockShikiState.engine,
  ShikiHighlighter: (props: { children: string } & Record<string, unknown>) => {
    mockShikiState.lastProps = props
    return (
      <div data-testid="shiki-container">
        <code>{props.children}</code>
      </div>
    )
  },
}))

describe('CodeViewer', () => {
  it('keeps the same inner padding for highlighted code content', async () => {
    const { container } = render(
      <CodeViewer code={'cd testb\nnpm run dev'} language="bash" showLineNumbers />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('shiki-container')).toBeTruthy()
    })

    const contentWrapper = container.querySelector('[data-code-viewer-content]') as HTMLElement | null
    expect(contentWrapper).toBeTruthy()
    expect(contentWrapper?.style.padding).toBe('0.5rem 12px')

    const codeArea = container.querySelector('.code-viewer-area') as HTMLElement | null
    expect(codeArea?.getAttribute('data-has-line-numbers')).toBe('true')
    expect(mockShikiState.lastProps?.engine).toBe(mockShikiState.engine)
  })
})
