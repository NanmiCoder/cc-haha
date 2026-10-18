import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileBottomSheet } from './MobileBottomSheet'
import { TOUCH_H5_ATTRIBUTE } from '@/lib/touchH5'

function Harness({ children, field }: { children?: React.ReactNode; field?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {field}
      <button type="button" onClick={() => setOpen(true)}>Open sheet</button>
      <MobileBottomSheet open={open} onClose={() => setOpen(false)} title="Settings" closeLabel="Close sheet">
        {children ?? <p>Sheet body</p>}
      </MobileBottomSheet>
    </>
  )
}

function openAndCloseFrom(element: HTMLElement) {
  element.focus()
  fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }))
  expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }))
}

afterEach(() => {
  document.documentElement.removeAttribute(TOUCH_H5_ATTRIBUTE)
})

describe('MobileBottomSheet focus', () => {
  it('takes focus when it opens and hands it back to what opened it', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open sheet' })
    opener.focus()
    fireEvent.click(opener)

    // A modal dialog is where a keyboard or screen reader user has to land.
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('leaves focus on a child that already took it', () => {
    render(<Harness><input aria-label="Search" autoFocus /></Harness>)
    fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }))

    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus()
  })

  describe('on a touch device', () => {
    it('does not hand focus back to a text field, which would raise the soft keyboard', () => {
      document.documentElement.setAttribute(TOUCH_H5_ATTRIBUTE, '')
      render(<Harness field={<input aria-label="Composer field" />} />)
      const field = screen.getByRole('textbox', { name: 'Composer field' })
      openAndCloseFrom(field)
      expect(field).not.toHaveFocus()
    })

    it('does not hand focus back to a rich-text editor either', () => {
      document.documentElement.setAttribute(TOUCH_H5_ATTRIBUTE, '')
      render(<Harness />)
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      editor.setAttribute('tabindex', '0')
      document.body.appendChild(editor)
      try {
        openAndCloseFrom(editor)
        expect(editor).not.toHaveFocus()
      } finally {
        editor.remove()
      }
    })

    it('still hands focus back to controls that raise no keyboard', () => {
      document.documentElement.setAttribute(TOUCH_H5_ATTRIBUTE, '')
      render(<Harness field={<><input type="checkbox" aria-label="Agree" /><select aria-label="Pick"><option>a</option></select></>} />)
      for (const control of [screen.getByRole('checkbox', { name: 'Agree' }), screen.getByRole('combobox', { name: 'Pick' })]) {
        openAndCloseFrom(control)
        expect(control).toHaveFocus()
      }
    })
  })

  describe('with a keyboard on a narrow desktop window', () => {
    it('hands focus back to the text field it came from', () => {
      render(<Harness field={<input aria-label="Composer field" />} />)
      const field = screen.getByRole('textbox', { name: 'Composer field' })
      openAndCloseFrom(field)
      expect(field).toHaveFocus()
    })
  })

  it('still closes on Escape', () => {
    const onClose = vi.fn()
    render(<MobileBottomSheet open onClose={onClose} title="Settings"><p>Body</p></MobileBottomSheet>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
