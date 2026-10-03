import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { TextArea } from './TextArea'

describe('TextArea', () => {
  it('has an id and a label that points at it', () => {
    // All 13 textareas in the app had neither, so clicking a nearby label did
    // not focus them.
    render(<TextArea label="System prompt" />)
    const textarea = screen.getByLabelText('System prompt')
    expect(textarea.id).toBeTruthy()
  })

  it('gives two identically-worded labels distinct ids', () => {
    render(
      <>
        <TextArea label="备注" />
        <TextArea label="备注" />
      </>,
    )
    const areas = screen.getAllByLabelText('备注')
    expect(areas[0]!.id).not.toBe(areas[1]!.id)
  })

  it('marks itself invalid and announces the error', () => {
    render(<TextArea label="Prompt" error="Cannot be empty" />)
    const textarea = screen.getByLabelText('Prompt')

    expect(textarea).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot be empty')
    expect(textarea.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  })

  it('links a hint when valid', () => {
    render(<TextArea label="Prompt" hint="Markdown is supported" />)
    const describedBy = screen.getByLabelText('Prompt').getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)).toHaveTextContent('Markdown is supported')
  })

  it('carries a disabled style', () => {
    render(<TextArea label="Prompt" disabled />)
    expect(screen.getByLabelText('Prompt')).toBeDisabled()
  })

  it('defaults to four rows and accepts an override', () => {
    const { rerender } = render(<TextArea label="Prompt" />)
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('rows', '4')

    rerender(<TextArea label="Prompt" rows={10} />)
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('rows', '10')
  })

  // The inline message editor focuses the field and moves the caret to the end
  // on open; without forwarding, a ref on a function component is dropped.
  it('forwards its ref to the textarea element', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<TextArea label="Prompt" ref={ref} />)
    expect(ref.current).toBe(screen.getByLabelText('Prompt'))
  })
})
