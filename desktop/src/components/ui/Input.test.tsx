import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { Input } from './Input'

describe('Input', () => {
  it('associates the label with the input', () => {
    render(<Input label="Server name" />)
    expect(screen.getByLabelText('Server name')).toBeInTheDocument()
  })

  it('gives two identically-worded Chinese labels distinct ids', () => {
    // The id used to be `label.toLowerCase().replace(/\s+/g, '-')`. Chinese has
    // no spaces, so the replace was a no-op and any two labels that normalized
    // the same shared an id — pointing one <label> at the other field's input.
    render(
      <>
        <Input label="名称" defaultValue="first" />
        <Input label="名称" defaultValue="second" />
      </>,
    )

    const inputs = screen.getAllByLabelText('名称')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]!.id).not.toBe(inputs[1]!.id)
  })

  it('marks itself invalid and announces the error', () => {
    render(<Input label="Port" error="Must be a number" />)
    const input = screen.getByLabelText('Port')

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Must be a number')
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  })

  it('is not marked invalid without an error', () => {
    render(<Input label="Port" />)
    expect(screen.getByLabelText('Port')).not.toHaveAttribute('aria-invalid')
  })

  it('links a hint when there is no error', () => {
    render(<Input label="Port" hint="Between 1024 and 65535" />)
    const describedBy = screen.getByLabelText('Port').getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)).toHaveTextContent('Between 1024 and 65535')
  })

  it('lets the error replace the hint', () => {
    render(<Input label="Port" hint="Between 1024 and 65535" error="Out of range" />)
    expect(screen.queryByText('Between 1024 and 65535')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Out of range')
  })

  it('carries a disabled style, which none of the 76 native inputs had', () => {
    render(<Input label="Port" disabled />)
    const input = screen.getByLabelText('Port')
    expect(input).toBeDisabled()
    expect(input.className).toContain('disabled:opacity-60')
  })

  it('marks required on the input, not just with an asterisk', () => {
    render(<Input label="Port" required />)
    expect(screen.getByLabelText(/Port/)).toBeRequired()
  })

  it('honors an explicit id', () => {
    render(<Input label="Port" id="custom-port" />)
    expect(screen.getByLabelText('Port')).toHaveAttribute('id', 'custom-port')
  })
})
