import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectorRow } from './ConnectorRow'
afterEach(cleanup)
it('separates the service details target from the compact add action and recovers a broken icon', () => {
  const details = vi.fn()
  const add = vi.fn()
  const { container } = render(<ConnectorRow id="test" name="Service" description="Search documents" kind="Connector" actionLabel="Add Service" added={false} onDetails={details} onAction={add} />)
  fireEvent.click(screen.getByRole('button', { name: 'Service' }))
  expect(details).toHaveBeenCalledTimes(1)
  expect(add).not.toHaveBeenCalled()
  const action = screen.getByRole('button', { name: 'Add Service' })
  expect(action.className).toContain('h-8')
  fireEvent.click(action)
  expect(add).toHaveBeenCalledTimes(1)
  fireEvent.error(container.querySelector('img')!)
  expect(container.querySelector('img')).toBeNull()
  expect(screen.getByText('S')).toBeInTheDocument()
})
it('omits the badge container when no type label is needed', () => {
  const { container } = render(<ConnectorRow id="test" name="Service" description="Search documents" actionLabel="Add Service" added={false} onDetails={vi.fn()} onAction={vi.fn()} />)
  expect(container.querySelector('span.border')).toBeNull()
  expect(screen.getByRole('button', { name: 'Service' })).toBeInTheDocument()
})
it('renders an explicit management action while preserving access to details', () => {
  const details = vi.fn()
  const remove = vi.fn()
  render(<ConnectorRow id="test" name="Service" description="Search documents" actionLabel="Details" added onDetails={details} onAction={vi.fn()} action={<button onClick={remove}>Uninstall</button>} />)
  expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
  expect(remove).toHaveBeenCalledOnce()
  expect(details).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Service' }))
  expect(details).toHaveBeenCalledOnce()
})
