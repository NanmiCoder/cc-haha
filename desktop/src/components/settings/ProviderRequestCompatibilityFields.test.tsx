import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useState } from 'react'

import { useSettingsStore } from '@/stores/settingsStore'
import { compatibilityForm } from '@/lib/providerRequestCompatibility'
import type { ApiFormat } from '@/types/provider'
import { ProviderRequestCompatibilityFields } from './ProviderRequestCompatibilityFields'

function Harness({ apiFormat }: { apiFormat: ApiFormat }) {
  const [value, setValue] = useState(compatibilityForm())
  return <ProviderRequestCompatibilityFields value={value} apiFormat={apiFormat} onChange={setValue} />
}

describe('ProviderRequestCompatibilityFields', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(cleanup)

  it('reveals the output budget field but hides advanced compatibility controls for anthropic providers', () => {
    render(<Harness apiFormat="anthropic" />)

    const budget = screen.getByLabelText('Reply output budget')
    expect(budget).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Advanced compatibility' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Known endpoint output limit')).not.toBeInTheDocument()

    fireEvent.change(budget, { target: { value: '1000' } })
    expect(budget).toHaveValue('1000')
  })

  it('keeps the budget field and advanced controls for openai chat providers', () => {
    render(<Harness apiFormat="openai_chat" />)

    expect(screen.getByLabelText('Reply output budget')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Advanced compatibility' })).toBeInTheDocument()
  })
})
