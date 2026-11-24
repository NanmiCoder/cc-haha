import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { Skeleton, SkeletonCards, SkeletonGroup, SkeletonRows } from './Skeleton'

describe('Skeleton', () => {
  it('is hidden from assistive tech on its own', () => {
    const { container } = render(<Skeleton />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('does not animate by itself', () => {
    // The pulse lives on the group so a cluster breathes as one object rather
    // than each bar pulsing on its own phase.
    const { container } = render(<Skeleton />)
    expect(container.firstElementChild?.className).not.toContain('animate-pulse')
  })

  it('makes circles square', () => {
    const { container } = render(<Skeleton shape="circle" height="2rem" />)
    const element = container.firstElementChild as HTMLElement
    expect(element.style.width).toBe('2rem')
    expect(element.style.height).toBe('2rem')
    expect(element.className).toContain('rounded-full')
  })

  it('offers exactly two placeholder shades', () => {
    const { container: base } = render(<Skeleton tone="base" />)
    const { container: strong } = render(<Skeleton tone="strong" />)
    expect(base.firstElementChild?.className).toContain('--color-surface-container)')
    expect(strong.firstElementChild?.className).toContain('--color-surface-container-high)')
  })
})

describe('SkeletonGroup', () => {
  it('is the only place that animates', () => {
    const { container } = render(<SkeletonGroup label="Loading"><Skeleton /></SkeletonGroup>)
    expect(container.firstElementChild?.className).toContain('animate-pulse')
  })

  it('announces the load with a busy status', () => {
    // The hand-rolled placeholders had neither role nor aria-busy, so a screen
    // reader saw an empty region and said nothing.
    render(<SkeletonGroup label="Loading sessions"><Skeleton /></SkeletonGroup>)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveTextContent('Loading sessions')
  })
})

describe('SkeletonRows', () => {
  it('renders count x lines placeholders under one group', () => {
    const { container } = render(<SkeletonRows label="Loading" count={3} lines={2} />)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(6)
  })

  it('can separate rows with dividers', () => {
    const { container } = render(<SkeletonRows label="Loading" count={2} divided />)
    expect(container.firstElementChild?.className).toContain('divide-y')
  })
})

describe('SkeletonCards', () => {
  it('renders the requested number of cards', () => {
    const { container } = render(<SkeletonCards label="Loading" count={4} />)
    expect(container.querySelectorAll('.border')).toHaveLength(4)
  })

  it('adds an avatar placeholder on request', () => {
    const { container: without } = render(<SkeletonCards label="Loading" count={1} />)
    const { container: withAvatar } = render(<SkeletonCards label="Loading" count={1} withAvatar />)

    expect(withAvatar.querySelectorAll('[aria-hidden="true"]').length)
      .toBeGreaterThan(without.querySelectorAll('[aria-hidden="true"]').length)
  })
})
