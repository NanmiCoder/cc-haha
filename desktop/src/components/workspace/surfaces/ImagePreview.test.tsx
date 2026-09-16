import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { ImagePreview } from './ImagePreview'

const dataUrl = 'data:image/png;base64,iVBORw0KGgo='

describe('ImagePreview', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders the decoded image and names it with the file path', () => {
    render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" />)

    const image = screen.getByRole('img', { name: 'assets/logo.png' })
    expect(image).toHaveAttribute('src', dataUrl)
  })

  it('shows the load error instead of an empty frame when there is no image data', () => {
    render(<ImagePreview path="assets/logo.png" error="File is too large" />)

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('File is too large')
  })

  it('falls back to the generic message when the failure carried no reason', () => {
    render(<ImagePreview path="assets/logo.png" />)

    expect(screen.getByRole('status')).toHaveTextContent('Image preview is unavailable.')
  })
})
