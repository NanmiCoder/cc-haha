import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'
import {
  AGENT_MASCOT_VARIANTS,
  AgentMascot,
  resolveAgentMascotSpec,
} from './AgentMascot'

describe('AgentMascot', () => {
  it('resolves the same seed to a stable mascot variant across statuses', () => {
    const running = resolveAgentMascotSpec({ seed: 'session-1:tool-1', status: 'running' })
    const completed = resolveAgentMascotSpec({ seed: 'session-1:tool-1', status: 'completed' })

    expect(running.variant).toBe(completed.variant)
    expect(running.motion).toBe('active')
    expect(completed.motion).toBe('still')
  })

  it.each([
    ['running', 'active', 'accent'],
    ['completed', 'still', 'success'],
    ['failed', 'still', 'danger'],
    ['stopped', 'still', 'danger'],
    ['pending', 'still', 'muted'],
  ] as const)('renders %s with semantic state metadata', (status, motion, tone) => {
    render(<AgentMascot seed="agent-seed" status={status} />)

    const mascot = screen.getByTestId('agent-mascot')

    expect(mascot).toHaveAttribute('data-agent-mascot-state', status)
    expect(mascot).toHaveAttribute('data-agent-mascot-motion', motion)
    expect(mascot).toHaveAttribute('data-agent-mascot-tone', tone)
    expect(mascot).toHaveAttribute('aria-hidden', 'true')
    expect(mascot).toHaveClass('h-[30px]')
    expect(mascot).toHaveClass('w-[30px]')
    expect(mascot.className).not.toContain('color-mix')
    expect(mascot.querySelector('img')).toHaveAttribute('alt', '')
    expect(mascot.querySelector('img')).toHaveAttribute('draggable', 'false')
  })

  it.each([
    ['running', 'v6c-ring-running'],
    ['completed', 'v6c-ring-success'],
    ['failed', 'v6c-ring-error'],
  ] as const)('applies crisp V6C status ring %s -> %s', (status, ringClass) => {
    render(<AgentMascot seed="agent-seed" status={status} />)
    expect(screen.getByTestId('agent-mascot')).toHaveClass(ringClass)
  })

  it('only renders a circular concentric motion ring for active agents', () => {
    const { rerender } = render(<AgentMascot seed="agent-seed" status="running" />)

    const mascot = screen.getByTestId('agent-mascot')
    const ring = screen.getByTestId('agent-mascot-motion-ring')
    expect(mascot).toHaveClass('rounded-full')
    expect(ring).toBeInTheDocument()
    expect(ring).toHaveClass('rounded-full', 'inset-0', 'motion-safe:animate-spin', 'motion-reduce:animate-none')

    rerender(<AgentMascot seed="agent-seed" status="completed" />)

    expect(screen.queryByTestId('agent-mascot-motion-ring')).not.toBeInTheDocument()
  })

  it('maps every mascot variant to a local generated image asset', () => {
    const { rerender } = render(<AgentMascot seed="agent-seed" status="running" />)

    for (const variant of AGENT_MASCOT_VARIANTS) {
      let seed = ''
      for (let index = 0; index < 10000; index += 1) {
        const candidate = `variant-${variant}-${index}`
        if (resolveAgentMascotSpec({ seed: candidate, status: 'running' }).variant === variant) {
          seed = candidate
          break
        }
      }
      expect(seed).not.toBe('')

      rerender(<AgentMascot seed={seed} status="running" />)

      const mascot = screen.getByTestId('agent-mascot')
      expect(mascot).toHaveAttribute('data-agent-mascot-variant', variant)
      expect(mascot.getAttribute('data-agent-mascot-src')).toContain(`agent-mascot-${variant}`)
      expect(mascot.querySelector('img')?.getAttribute('src')).toContain(`agent-mascot-${variant}`)
    }
  })
})
