import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrajectoryRow } from '../../types/trajectory'

vi.mock('../../api/trajectory', () => ({
  trajectoryApi: {
    getRow: vi.fn(async () => ({ rowId: 'a:1', truncated: false, entries: [] })),
    getSnapshot: vi.fn(),
    getTraceCallsNear: vi.fn(async () => ({ captured: false, calls: [] })),
  },
}))

import { TrajectoryDetailPanel } from './TrajectoryDetailPanel'
import { clearTrajectoryDetailCache } from './useTrajectoryDetail'
import { useSettingsStore } from '../../stores/settingsStore'

const ROW: TrajectoryRow = { id: 'a:1', kind: 'assistant', turn: 2, ts: '2026-10-04T10:00:01.000Z', preview: 'Hello', loc: [[0, 10]] }

function renderPanel(props: Partial<Parameters<typeof TrajectoryDetailPanel>[0]> = {}) {
  const handlers = { onWidthChange: vi.fn(), onClose: vi.fn() }
  render(
    <TrajectoryDetailPanel
      sessionId="s1"
      row={ROW}
      width={600}
      maxWidth={900}
      mode="side"
      allowRawRequest
      running={false}
      onLocateInChat={null}
      onOpenAgent={vi.fn()}
      onSelectRow={vi.fn()}
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

describe('TrajectoryDetailPanel', () => {
  beforeEach(() => {
    clearTrajectoryDetailCache()
    useSettingsStore.setState({ locale: 'en' })
  })

  it('never grows past the room the ledger leaves it', () => {
    // Regression: a fixed 600px panel squeezed the ledger to 19px with the workspace open.
    renderPanel({ width: 720, maxWidth: 400 })
    expect(screen.getByTestId('trajectory-detail')).toHaveStyle({ width: '400px' })
  })

  it('clamps resizing to the available room', () => {
    const { onWidthChange } = renderPanel({ width: 400, maxWidth: 420 })
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize details panel' }), { key: 'ArrowLeft' })
    expect(onWidthChange).toHaveBeenLastCalledWith(416)
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize details panel' }), { key: 'ArrowLeft' })
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize details panel' }))
    expect(onWidthChange).toHaveBeenLastCalledWith(420)
  })

  it('becomes a full-width drawer with a back button in a narrow column', () => {
    const { onClose } = renderPanel({ mode: 'drawer' })
    const panel = screen.getByTestId('trajectory-detail')
    expect(panel).toHaveAttribute('data-mode', 'drawer')
    expect(panel).toHaveStyle({ width: '100%' })
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('offers the raw request tab on main-session responses, and only there', () => {
    renderPanel()
    expect(screen.getByRole('tab', { name: 'Raw request' })).toBeInTheDocument()
  })

  it('lets the raw JSON fill the panel instead of a capped inner box', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }))
    const area = await waitFor(() => {
      const element = screen.getByTestId('trajectory-detail').querySelector('.code-viewer-area')
      expect(element).toBeTruthy()
      return element!
    })
    expect(area.className).not.toContain('max-h-')
  })

  it('hides the raw request tab for a subagent response', () => {
    renderPanel({ allowRawRequest: false })
    expect(screen.queryByRole('tab', { name: 'Raw request' })).not.toBeInTheDocument()
  })
})
