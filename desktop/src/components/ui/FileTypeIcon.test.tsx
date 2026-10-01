import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FileTypeIcon } from './FileTypeIcon'

describe('FileTypeIcon', () => {
  it.each([
    ['报告.pdf', 'pdf', 'PDF'],
    ['README.md', 'markdown', 'MD'],
    ['简报.docx', 'docx', 'DOCX'],
    ['C:\\out\\data.xlsx', 'xlsx', 'XLSX'],
    ['table.xlsm', 'xlsx', 'XLSM'],
    ['deck.pptx', 'pptx', 'PPTX'],
    ['bundle.zip', 'zip', 'ZIP'],
    ['main.rs', 'code', 'RS'],
    ['notes.mdx', 'markdown', 'MDX'],
    ['events.jsonl', 'json', 'JSONL'],
  ])('renders a labelled icon for %s', (path, kind, label) => {
    const { container } = render(<FileTypeIcon path={path} />)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveAttribute('data-file-type', kind)
    expect(root).toHaveAttribute('aria-hidden', 'true')
    expect(root.querySelector('svg')).not.toBeNull()
    expect(root.textContent?.toUpperCase()).toContain(label)
  })

  it('falls back to a neutral icon for extensionless and unknown files', () => {
    for (const path of ['Makefile', 'weird.zzz']) {
      const { container } = render(<FileTypeIcon path={path} />)
      expect(container.firstElementChild).toHaveAttribute('data-file-type', 'file')
      expect(container.querySelector('svg')).not.toBeNull()
    }
  })

  it('keeps markdown blue, distinct from the grey library default', () => {
    const { container } = render(<FileTypeIcon path="a.md" />)
    expect(container.innerHTML.toLowerCase()).toContain('#3b6fe0')
  })
})
