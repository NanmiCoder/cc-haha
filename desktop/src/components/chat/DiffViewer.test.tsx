import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'

const { diffViewerMock } = vi.hoisted(() => ({
  diffViewerMock: vi.fn(),
}))

vi.mock('react-diff-viewer-continued', () => ({
  default: (props: { useDarkTheme: boolean }) => {
    diffViewerMock(props)
    return <div data-testid="diff-viewer" data-dark-theme={String(props.useDarkTheme)} />
  },
  DiffMethod: {
    WORDS: 'WORDS',
  },
}))

import { useUIStore } from '../../stores/uiStore'
import { DiffViewer } from './DiffViewer'

describe('DiffViewer', () => {
  beforeEach(() => {
    diffViewerMock.mockReset()
    useUIStore.setState({ theme: 'white' })
  })

  it.each(['dark', 'ink-blue', 'neutral-dark'] as const)('uses the dark diff renderer on %s and returns to a light renderer', (theme) => {
    const { rerender } = render(
      <DiffViewer filePath="src/example.ts" oldString="const a = 1" newString="const a = 2" />,
    )

    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-dark-theme', 'false')

    act(() => {
      useUIStore.setState({ theme })
    })
    rerender(<DiffViewer filePath="src/example.ts" oldString="const a = 1" newString="const a = 2" />)

    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-dark-theme', 'true')
    expect(diffViewerMock).toHaveBeenLastCalledWith(expect.objectContaining({ useDarkTheme: true }))

    act(() => useUIStore.setState({ theme: 'white' }))
    expect(screen.getByTestId('diff-viewer')).toHaveAttribute('data-dark-theme', 'false')
  })
})
