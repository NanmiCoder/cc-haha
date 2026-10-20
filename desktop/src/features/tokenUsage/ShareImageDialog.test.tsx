import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import type { ActivityStatsResponse } from '../../api/activityStats'
import { useSettingsStore } from '../../stores/settingsStore'
import { ShareImageDialog } from './ShareImageDialog'
import type { ShareOptions } from './shareImage/layout'
import type { DailyModelSeries, RankedModel } from './usageModel'

const { renderShareImageMock, loadShareAssetsMock, disposeMock } = vi.hoisted(() => ({
  renderShareImageMock: vi.fn(),
  loadShareAssetsMock: vi.fn(),
  disposeMock: vi.fn(),
}))

vi.mock('./shareImage/render', () => ({
  renderShareImage: renderShareImageMock,
  loadShareAssets: loadShareAssetsMock,
}))

const stats = {
  range: 'all', generatedAt: '', totalSessions: 5, totalMessages: 0, totalDays: 10, activeDays: 4,
  streaks: { currentStreak: 2, longestStreak: 3, currentStreakStart: null, longestStreakStart: null, longestStreakEnd: null },
  dailyActivity: [], dailyModelTokens: [], longestSession: null, modelUsage: {}, toolUsage: {}, skillUsage: {},
  firstSessionDate: null, lastSessionDate: null, peakActivityDay: null, peakActivityHour: null, totalSpeculationTimeSavedMs: 0,
} as ActivityStatsResponse

const models: RankedModel[] = [
  { id: 'a', label: 'Alpha', series: 1, total: 900, fresh: 100, cached: 800, costUSD: 1, unpriced: false },
]
const daily: DailyModelSeries[] = [
  { date: '2026-10-16', total: 400, byModel: [400], otherModels: [] },
  { date: '2026-10-17', total: 500, byModel: [500], otherModels: [] },
]

const fakeCanvas = () => ({
  toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(['png'], { type: 'image/png' })),
})

function lastRenderOptions(): ShareOptions {
  return renderShareImageMock.mock.calls[renderShareImageMock.mock.calls.length - 1]![0].options
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
}

const dialogProfile = { displayName: 'Ada', subtitle: 'github.com/NanmiCoder/cc-haha' }

function dialogElement(open: boolean, onClose: () => void, overrides: Partial<Parameters<typeof ShareImageDialog>[0]> = {}) {
  return (
    <ShareImageDialog
      open={open}
      onClose={onClose}
      stats={stats}
      models={models}
      daily={daily}
      totalTokens={900}
      locale="en"
      profile={dialogProfile}
      avatarUrl={null}
      {...overrides}
    />
  )
}

function renderDialog(overrides: Partial<Parameters<typeof ShareImageDialog>[0]> = {}) {
  const onClose = vi.fn()
  const view = render(dialogElement(true, onClose, overrides))
  return { onClose, setOpen: (open: boolean) => act(() => { view.rerender(dialogElement(open, onClose, overrides)) }) }
}

describe('ShareImageDialog', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    renderShareImageMock.mockReset()
    renderShareImageMock.mockImplementation(async () => ({ canvas: fakeCanvas(), layout: {} }))
    loadShareAssetsMock.mockReset()
    disposeMock.mockReset()
    loadShareAssetsMock.mockResolvedValue({ avatar: null, icon: null, dispose: disposeMock })
    URL.createObjectURL = vi.fn(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('draws a portrait preview in the current theme with the project link on and cost off', async () => {
    renderDialog()
    expect(screen.getByText('Drawing…')).toBeInTheDocument()

    await settle()

    expect(screen.getByAltText('Preview of the share image')).toHaveAttribute('src', 'blob:preview')
    expect(lastRenderOptions()).toEqual({
      size: 'portrait', showIdentity: true, showModels: true, showLink: true, showCost: false,
    })
    // Cost is something to opt into: a posted picture should not carry a spend figure by default.
    expect(screen.getByRole('checkbox', { name: /Estimated cost/ })).not.toBeChecked()
    expect(screen.getByText('1080 × 1350')).toBeInTheDocument()
  })

  it('redraws when the size, theme or a toggle changes', async () => {
    renderDialog()
    await settle()
    const initialCalls = renderShareImageMock.mock.calls.length

    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }))
    await settle()
    expect(lastRenderOptions().size).toBe('wide')
    expect(screen.getByText('1200 × 630')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Project link' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Estimated cost/ }))
    await settle()
    expect(lastRenderOptions()).toMatchObject({ size: 'wide', showLink: false, showCost: true })

    fireEvent.change(screen.getByLabelText('Image theme'), { target: { value: 'celadon' } })
    await settle()
    expect(renderShareImageMock.mock.calls.length).toBeGreaterThan(initialCalls + 2)
    // The image is drawn in the chosen palette, whatever theme the app shows.
    const themeUsed = renderShareImageMock.mock.calls[renderShareImageMock.mock.calls.length - 1]![0].theme
    expect(themeUsed).toHaveProperty('series')
    expect(themeUsed.series).toHaveLength(5)
  })

  it('offers every theme, led by "follow the current one"', async () => {
    renderDialog()
    await settle()

    const select = screen.getByLabelText('Image theme') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'current', 'white', 'paper', 'warm-classic', 'celadon', 'dark', 'ink-blue',
    ])
    expect(select.value).toBe('current')
  })

  it('saves the rendered PNG under a dated name', async () => {
    renderDialog()
    await settle()
    const clicks: Array<{ href: string; download: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save PNG' }))

    expect(clicks).toHaveLength(1)
    expect(clicks[0]!.download).toMatch(/^cc-haha-token-usage-\d{8}\.png$/)
  })

  it('copies the image to the clipboard and says so, or says it could not', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    class FakeClipboardItem { constructor(public items: Record<string, Blob>) {} }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
    renderDialog()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    await settle()

    expect(write).toHaveBeenCalledTimes(1)
    expect((write.mock.calls[0]![0][0] as FakeClipboardItem).items['image/png']).toBeInstanceOf(Blob)
    expect(screen.getByRole('status')).toHaveTextContent('Copied')

    write.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Could not copy the image')
    vi.unstubAllGlobals()
  })

  it('keeps the buttons off until there is an image, and reports a drawing failure', async () => {
    renderShareImageMock.mockRejectedValue(new Error('no canvas'))
    renderDialog()

    expect(screen.getByRole('button', { name: 'Save PNG' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copy image' })).toBeDisabled()
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent('Could not draw the image')
    expect(screen.getByRole('button', { name: 'Save PNG' })).toBeDisabled()
  })

  it('asks to close from its close button', async () => {
    const { onClose } = renderDialog()
    await settle()
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: /close/i })[0]!)
    expect(onClose).toHaveBeenCalled()
  })

  it('releases the avatar picture when it closes', async () => {
    const { setOpen } = renderDialog()
    await settle()
    expect(disposeMock).not.toHaveBeenCalled()

    setOpen(false)
    await settle()
    expect(disposeMock).toHaveBeenCalledTimes(1)
  })

  it('draws and loads nothing while closed', async () => {
    renderDialog({ open: false })
    await settle()
    expect(loadShareAssetsMock).not.toHaveBeenCalled()
    expect(renderShareImageMock).not.toHaveBeenCalled()
  })

  it('does not reopen on a preview whose URL was already revoked, and keeps Save off until the new one exists', async () => {
    const revoked: string[] = []
    let made = 0
    URL.createObjectURL = vi.fn(() => `blob:preview-${++made}`)
    URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url) })

    const { setOpen } = renderDialog()
    await settle()
    const first = (screen.getByAltText('Preview of the share image') as HTMLImageElement).src

    setOpen(false)
    await settle()
    expect(revoked).toContain(first)

    // Reopened, before the new drawing has finished: no image at all, not the revoked one.
    renderShareImageMock.mockImplementationOnce(() => new Promise(() => {}))
    setOpen(true)
    expect(screen.queryByAltText('Preview of the share image')).not.toBeInTheDocument()
    expect(screen.getByText('Drawing…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save PNG' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copy image' })).toBeDisabled()
    await settle()
  })

  it('will not save or copy the previous image while the new options are still being drawn', async () => {
    renderDialog()
    await settle()
    expect(screen.getByRole('button', { name: 'Save PNG' })).toBeEnabled()

    let finish: () => void = () => {}
    renderShareImageMock.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ canvas: fakeCanvas(), layout: {} })
    }))
    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }))

    expect(screen.getByRole('button', { name: 'Save PNG' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copy image' })).toBeDisabled()

    finish()
    await settle()
    expect(screen.getByRole('button', { name: 'Save PNG' })).toBeEnabled()
  })
})
