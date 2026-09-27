import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { ComposerSuggestionRow } from '@/components/chat/ComposerSuggestionRow'

it('separates the accessible name from detail and forwards selection, events and ref', () => {
  const ref = createRef<HTMLDivElement>()
  const onClick = vi.fn()
  const onMouseEnter = vi.fn()
  render(<ComposerSuggestionRow ref={ref} id="item" label="Design" description="Build interfaces" selected onClick={onClick} onMouseEnter={onMouseEnter} trailing={<span>Personal</span>} />)
  const option = screen.getByRole('option', { name: 'Design' })
  expect(option).toHaveAccessibleDescription('Build interfaces')
  expect(option).toHaveAttribute('aria-selected', 'true')
  expect(ref.current).toBe(option)
  fireEvent.mouseEnter(option)
  fireEvent.click(option)
  expect(onMouseEnter).toHaveBeenCalledOnce()
  expect(onClick).toHaveBeenCalledOnce()
})
