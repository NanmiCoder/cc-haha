import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkspaceFileIcon } from './WorkspaceFileIcon'

describe('WorkspaceFileIcon', () => {
  it.each([
    ['src/client.ts', 'ts'],
    ['src/Panel.TSX', 'ts'],
    ['C:\\repo\\index.jsx', 'js'],
    ['package.json', 'json'],
    ['events.jsonl', 'json'],
    ['README.md', 'markdown'],
    ['photo.png', 'image'],
    ['report.pdf', 'pdf'],
    ['bundle.zip', 'archive'],
    ['.gitignore', 'file'],
    ['unknown.xyz', 'file'],
  ])('identifies %s without repeating the filename for assistive technology', (path, type) => {
    const { container } = render(<WorkspaceFileIcon path={path} />)
    expect(container.firstElementChild).toHaveAttribute('data-file-type', type)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(container.firstElementChild).not.toHaveAttribute('tabindex')
  })

  it('sizes language markers for both tabs and tree rows using paired theme colors', () => {
    const { container } = render(<WorkspaceFileIcon path="client.ts" size={18} className="opacity-80" />)
    expect(container.firstElementChild).toHaveTextContent('TS')
    expect(container.firstElementChild).toHaveStyle({ width: '18px', height: '18px', color: 'var(--color-on-file-typescript-container)', backgroundColor: 'var(--color-file-typescript-container)' })
    expect(container.firstElementChild).toHaveClass('opacity-80')
  })
})
