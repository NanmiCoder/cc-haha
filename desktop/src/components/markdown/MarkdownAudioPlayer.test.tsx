import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, setAuthToken } from '@/api/client'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useSettingsStore } from '@/stores/settingsStore'
import { MarkdownAudioPlayer } from './MarkdownAudioPlayer'

const fetchServerImageBlobUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/authedImage', () => ({ fetchServerImageBlobUrl }))

beforeEach(() => {
  fetchServerImageBlobUrl.mockReset().mockRejectedValue(new ApiError(500, { error: 'Internal error' }))
  setAuthToken(null)
  Reflect.deleteProperty(window, 'desktopHost')
  useSettingsStore.setState({ locale: 'en' })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

afterEach(() => {
  setAuthToken(null)
  Reflect.deleteProperty(window, 'desktopHost')
})

describe('MarkdownAudioPlayer', () => {
  it('renders an accessible native audio player with label, filename, and metadata preloading', () => {
    const { container } = render(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/preview-fs/s1/outputs/sfx/plane-crash.wav"
        label="飞机坠毁音效"
      />,
    )

    const card = container.querySelector('[data-md-audio-card]')!
    expect(card).toHaveClass('v6c-glass-card', 'rounded-[var(--radius-card-inner)]')
    const audio = container.querySelector('audio')!
    expect(audio).toBeInTheDocument()
    expect(audio).toHaveAttribute('controls')
    expect(audio).toHaveAttribute('preload', 'metadata')
    expect(audio).not.toHaveAttribute('autoplay')
    expect(audio).toHaveAttribute('aria-label', '飞机坠毁音效')
    expect(audio).toHaveAttribute('src', 'http://127.0.0.1:4321/preview-fs/s1/outputs/sfx/plane-crash.wav')
    expect(screen.getByText('飞机坠毁音效')).toBeVisible()
    expect(screen.getByText('plane-crash.wav')).toBeVisible()
  })

  it('uses the decoded filename when no label is given without duplicating it', () => {
    render(
      <MarkdownAudioPlayer src="http://127.0.0.1:4321/api/filesystem/file?path=%2Ftmp%2F%E9%9F%B3%E6%95%88.wav" />,
    )

    expect(screen.getAllByText('音效.wav')).toHaveLength(1)
  })

  it('pauses the previously playing inline audio player when another starts for A/B auditioning', () => {
    const { container } = render(
      <>
        <MarkdownAudioPlayer src="http://127.0.0.1:4321/preview-fs/s1/take-1.wav" label="Take 1" />
        <MarkdownAudioPlayer src="http://127.0.0.1:4321/preview-fs/s1/take-2.wav" label="Take 2" />
      </>,
    )

    const [first, second] = Array.from(container.querySelectorAll('audio'))
    const pauseFirst = vi.spyOn(first!, 'pause').mockImplementation(() => undefined)
    const pauseSecond = vi.spyOn(second!, 'pause').mockImplementation(() => undefined)

    fireEvent.play(first!)
    expect(pauseFirst).not.toHaveBeenCalled()
    expect(pauseSecond).not.toHaveBeenCalled()

    fireEvent.play(second!)
    expect(pauseFirst).toHaveBeenCalledTimes(1)
    expect(pauseSecond).not.toHaveBeenCalled()

    fireEvent.pause(second!)
  })

  it('retries a refused local audio stream with the app credential', async () => {
    fetchServerImageBlobUrl.mockResolvedValueOnce('blob:http://localhost/audio-1')
    const { container } = render(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/preview-fs/s1/plane-crash.wav"
        label="Crash"
      />,
    )

    fireEvent.error(container.querySelector('audio')!)

    await waitFor(() => {
      expect(container.querySelector('audio')).toHaveAttribute('src', 'blob:http://localhost/audio-1')
    })
    expect(fetchServerImageBlobUrl).toHaveBeenCalledWith('http://127.0.0.1:4321/preview-fs/s1/plane-crash.wav')
  })

  it.each([404, 403])('falls back quietly to the label after HTTP %i without a retryable error alert', async (status) => {
    fetchServerImageBlobUrl.mockRejectedValue(new ApiError(status, { error: 'refused' }))
    const { container } = render(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/api/filesystem/file?path=%2Ftmp%2Fmissing.wav"
        label="飞机坠毁音效"
      />,
    )

    fireEvent.error(container.querySelector('audio')!)

    await waitFor(() => expect(container.querySelector('[data-md-audio-card]')).not.toBeVisible())
    expect(screen.getAllByText('飞机坠毁音效').some((el) => el.closest('[data-md-audio-card]') === null)).toBe(true)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry audio/ })).not.toBeInTheDocument()
  })

  it.each([
    ['en', 'Unable to load audio', 'Retry audio: 音效.wav', 'Retry'],
    ['zh', '无法加载音频', '重试音频：音效.wav', '重试'],
    ['zh-TW', '無法載入音訊', '重試音訊：音效.wav', '重試'],
    ['jp', '音声を読み込めません', '音声を再読み込み: 音效.wav', '再試行'],
    ['kr', '오디오를 불러올 수 없습니다', '오디오 다시 시도: 音效.wav', '다시 시도'],
  ] as const)('translates the error, retry button, and accessible name in %s', async (locale, title, name, retry) => {
    useSettingsStore.setState({ locale })
    const { container } = render(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/preview-fs/s1/%E9%9F%B3%E6%95%88.wav"
        label="SFX"
      />,
    )

    fireEvent.error(container.querySelector('audio')!)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(title)
    const button = screen.getByRole('button', { name })
    expect(button).toHaveTextContent(retry)
    expect(button).toHaveAttribute('aria-describedby')
    expect(button.className).toContain('focus-visible:ring-2')
  })

  it('recovers from a server fault once a retry loads metadata', async () => {
    fetchServerImageBlobUrl
      .mockRejectedValueOnce(new ApiError(500, { error: 'boom' }))
      .mockResolvedValueOnce('blob:http://localhost/recovered')
    const { container } = render(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/preview-fs/s1/take-1.wav"
        label="Take 1"
      />,
    )

    fireEvent.error(container.querySelector('audio')!)
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: 'Retry audio: take-1.wav' }))
    await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', 'blob:http://localhost/recovered'))
    fireEvent.loadedMetadata(container.querySelector('audio')!)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(container.querySelector('[data-md-audio-card]')).toBeVisible()
  })

  it('updates localized error text if the locale changes while visible', async () => {
    const { container } = render(
      <MarkdownAudioPlayer src="http://127.0.0.1:4321/preview-fs/s1/take-1.wav" label="Take 1" />,
    )
    fireEvent.error(container.querySelector('audio')!)
    await screen.findByRole('alert')

    act(() => useSettingsStore.setState({ locale: 'zh' }))
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载音频')
    expect(screen.getByRole('button', { name: '重试音频：take-1.wav' })).toBeInTheDocument()
  })

  it('defers preload on authenticated non-Electron browsers (LAN H5) and resumes playback after auth blob fallback', async () => {
    setAuthToken('h5-token')
    fetchServerImageBlobUrl.mockResolvedValueOnce('blob:http://localhost/h5-audio')
    const { container } = render(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/preview-fs/s1/take-1.wav"
        label="Take 1"
      />,
    )

    const audio = container.querySelector('audio')!
    expect(audio).toHaveAttribute('preload', 'none')
    expect(fetchServerImageBlobUrl).not.toHaveBeenCalled()

    const playSpy = vi.spyOn(audio, 'play').mockResolvedValue(undefined)
    fireEvent.play(audio)
    fireEvent.error(audio)

    await waitFor(() => expect(audio).toHaveAttribute('src', 'blob:http://localhost/h5-audio'))
    fireEvent.canPlay(audio)
    expect(playSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps metadata preload on Electron desktop even when an auth token is configured', () => {
    setAuthToken('desktop-token')
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true }
    const { container } = render(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/preview-fs/s1/take-1.wav"
        label="Take 1"
      />,
    )

    expect(container.querySelector('audio')).toHaveAttribute('preload', 'metadata')
  })

  it('pauses active playback on unmount and resets failure state when src changes', async () => {
    const { container, rerender, unmount } = render(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/preview-fs/s1/broken.wav"
        label="Broken"
      />,
    )

    const audio = container.querySelector('audio')!
    fireEvent.error(audio)
    await screen.findByRole('alert')

    rerender(
      <MarkdownAudioPlayer
        src="http://127.0.0.1:4321/preview-fs/s1/fresh.wav"
        label="Fresh"
      />,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    const freshAudio = container.querySelector('audio')!
    const freshPauseSpy = vi.spyOn(freshAudio, 'pause').mockImplementation(() => undefined)
    fireEvent.play(freshAudio)
    unmount()
    expect(freshPauseSpy).toHaveBeenCalledTimes(1)
  })
})
