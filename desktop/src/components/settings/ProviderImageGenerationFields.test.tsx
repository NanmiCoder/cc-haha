import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useState } from 'react'

import { useSettingsStore } from '@/stores/settingsStore'
import {
  ProviderImageGenerationFields,
  type ImageGenerationFormValue,
} from './ProviderImageGenerationFields'

function Harness() {
  const [value, setValue] = useState<ImageGenerationFormValue>({
    enabled: false,
    model: '',
    baseUrl: '',
    apiKey: '',
  })
  return <ProviderImageGenerationFields value={value} onChange={setValue} />
}

describe('ProviderImageGenerationFields', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(cleanup)

  it('reveals a required image model and optional credential overrides from the real toggle', () => {
    render(<Harness />)

    const toggle = screen.getByRole('switch', { name: 'Enable image generation' })
    expect(screen.queryByLabelText('Image model')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    const model = screen.getByRole('textbox', { name: /Image model/ })
    expect(model).toBeRequired()
    expect(screen.getByLabelText('Image API Base URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Image API key')).toHaveAttribute('type', 'password')

    fireEvent.change(model, { target: { value: 'gpt-image-2' } })
    expect(model).toHaveValue('gpt-image-2')
  })
})
