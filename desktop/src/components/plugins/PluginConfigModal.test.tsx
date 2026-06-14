import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PluginConfigModal } from './PluginConfigModal'

// Mock the plugins API
const mockGetOptions = vi.fn()
const mockSaveOptions = vi.fn()
vi.mock('../../api/plugins', () => ({
  pluginsApi: {
    getOptions: (...args: unknown[]) => mockGetOptions(...args),
    saveOptions: (...args: unknown[]) => mockSaveOptions(...args),
  },
}))

// Mock useUIStore — zustand store with selector pattern
const mockAddToast = vi.fn()
vi.mock('../../stores/uiStore', () => {
  const store = { addToast: mockAddToast }
  const useUIStore = (selector: (s: typeof store) => unknown) => selector(store)
  useUIStore.getState = () => store
  return { useUIStore }
})

const testSchema = {
  API_KEY: {
    type: 'string',
    title: 'API Key',
    description: 'Your API key',
    required: true,
    sensitive: true,
  },
  BASE_URL: {
    type: 'string',
    title: 'Base URL',
    description: 'API endpoint',
    default: 'https://example.com',
  },
  ENABLED: {
    type: 'boolean',
    title: 'Enable feature',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOptions.mockResolvedValue({
    pluginId: 'test@market',
    schema: testSchema,
    values: { API_KEY: '********', BASE_URL: 'https://custom.com', ENABLED: '' },
  })
  mockSaveOptions.mockResolvedValue({ ok: true })
})

describe('PluginConfigModal', () => {
  it('renders nothing when closed', () => {
    render(
      <PluginConfigModal
        open={false}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText('Configure Test Plugin')).not.toBeInTheDocument()
  })

  it('renders title and fields when open', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('Configure Test Plugin')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('API Key')).toBeInTheDocument()
      expect(screen.getByText('Base URL')).toBeInTheDocument()
      expect(screen.getByText('Enable feature')).toBeInTheDocument()
    })
  })

  it('fetches options on open and populates fields', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(mockGetOptions).toHaveBeenCalledWith('test@market')
    })

    // Non-sensitive field should show the value
    await waitFor(() => {
      const baseUrlInput = screen.getByDisplayValue('https://custom.com')
      expect(baseUrlInput).toBeInTheDocument()
    })
  })

  it('renders sensitive fields as password input', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      // Find the password input for API_KEY
      const passwordInputs = document.querySelectorAll('input[type="password"]')
      expect(passwordInputs.length).toBeGreaterThan(0)
    })
  })

  it('renders secure badge for sensitive fields', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('secure')).toBeInTheDocument()
    })
  })

  it('saves without masked values when user did not modify sensitive field', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    // Wait for fetch to complete
    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.com')).toBeInTheDocument()
    })

    // Click Save
    const saveButton = screen.getByText('Save')
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(mockSaveOptions).toHaveBeenCalledWith(
        'test@market',
        // Should NOT include API_KEY: '********' (masked value skipped)
        expect.objectContaining({ BASE_URL: 'https://custom.com' }),
      )
      // Verify API_KEY is not in the saved values
      const savedValues = mockSaveOptions.mock.calls[0]![1] as Record<string, string>
      expect(savedValues).not.toHaveProperty('API_KEY')
    })
  })

  it('saves modified sensitive field when user changes it', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.com')).toBeInTheDocument()
    })

    // Find and modify the password input
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(passwordInput, { target: { value: 'sk-new-key' } })

    const saveButton = screen.getByText('Save')
    fireEvent.click(saveButton)

    await waitFor(() => {
      const savedValues = mockSaveOptions.mock.calls[0]![1] as Record<string, string>
      expect(savedValues.API_KEY).toBe('sk-new-key')
    })
  })

  it('calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn()
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={onClose}
      />,
    )

    const cancelButton = screen.getByText('Cancel')
    fireEvent.click(cancelButton)

    expect(onClose).toHaveBeenCalled()
  })

  it('calls onSaved after successful save', async () => {
    const onSaved = vi.fn()
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.com')).toBeInTheDocument()
    })

    const saveButton = screen.getByText('Save')
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })
  })

  it('shows toast on save error', async () => {
    mockSaveOptions.mockRejectedValue(new Error('Network error'))

    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.com')).toBeInTheDocument()
    })

    const saveButton = screen.getByText('Save')
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Network error' }),
      )
    })
  })
})
