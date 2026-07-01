import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Skeleton, SkeletonText, SkeletonCircle } from './Skeleton'

describe('Skeleton', () => {
  it('renders with default props', () => {
    render(<Skeleton />)
    const skeleton = screen.getByRole('status')
    expect(skeleton).toBeInTheDocument()
    expect(skeleton).toHaveAttribute('aria-label', 'Loading')
  })

  it('applies variant classes correctly', () => {
    const { rerender } = render(<Skeleton variant="text" />)
    expect(screen.getByRole('status')).toHaveClass('rounded')

    rerender(<Skeleton variant="circle" />)
    expect(screen.getByRole('status')).toHaveClass('rounded-full')

    rerender(<Skeleton variant="rect" />)
    expect(screen.getByRole('status')).toHaveClass('rounded-[var(--radius-md)]')
  })

  it('applies custom dimensions', () => {
    render(<Skeleton width={100} height={20} />)
    const skeleton = screen.getByRole('status')
    expect(skeleton).toHaveStyle({ width: '100px', height: '20px' })
  })

  it('renders multiple items when count > 1', () => {
    render(<Skeleton count={3} />)
    const container = screen.getByRole('status')
    expect(container.children).toHaveLength(3)
  })

  it('applies custom className', () => {
    render(<Skeleton className="custom-class" />)
    expect(screen.getByRole('status')).toHaveClass('custom-class')
  })
})

describe('SkeletonText', () => {
  it('renders multiple text lines', () => {
    render(<SkeletonText lines={4} />)
    const container = screen.getByRole('status')
    expect(container.children).toHaveLength(4)
  })
})

describe('SkeletonCircle', () => {
  it('renders with custom size', () => {
    render(<SkeletonCircle size={48} />)
    const skeleton = screen.getByRole('status')
    expect(skeleton).toHaveStyle({ width: '48px', height: '48px' })
    expect(skeleton).toHaveClass('rounded-full')
  })
})
