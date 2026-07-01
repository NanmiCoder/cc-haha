import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodeViewer } from './CodeViewer'

describe('CodeViewer', () => {
  it('keeps the same inner padding for highlighted code content', () => {
    const { container } = render(
      <CodeViewer code={'cd testb\nnpm run dev'} language="bash" showLineNumbers />,
    )

    expect(screen.getByText('cd testb')).toBeTruthy()
    expect(screen.getByText('npm run dev')).toBeTruthy()

    const contentWrapper = container.querySelector('[data-code-viewer-content]') as HTMLElement | null
    expect(contentWrapper).toBeTruthy()
    expect(contentWrapper?.style.padding).toBe('0.5rem 12px')
    expect(contentWrapper?.style.whiteSpace).toBe('pre')
    expect(contentWrapper?.style.wordBreak).toBe('normal')

    const codeArea = container.querySelector('.code-viewer-area') as HTMLElement | null
    expect(codeArea?.getAttribute('data-has-line-numbers')).toBe('true')
    expect(container.querySelector('[data-line-number="1"]')).toBeTruthy()
    expect(container.querySelector('[data-line-number="2"]')).toBeTruthy()
  })
})
