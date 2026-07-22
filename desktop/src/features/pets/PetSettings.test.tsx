import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { DesktopPetPreferences } from '../../api/desktopUiPreferences'
import { useSettingsStore } from '../../stores/settingsStore'
import { PetSettings } from './PetSettings'

const {
  getPreferencesMock,
  updatePetPreferencesMock,
  listPetsMock,
  createFromImageMock,
  createFromAtlasMock,
  openFolderMock,
  showPetMock,
  hidePetMock,
  onVisibilityChangedMock,
} = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(),
  updatePetPreferencesMock: vi.fn(),
  listPetsMock: vi.fn(),
  createFromImageMock: vi.fn(),
  createFromAtlasMock: vi.fn(),
  openFolderMock: vi.fn(),
  showPetMock: vi.fn(),
  hidePetMock: vi.fn(),
  onVisibilityChangedMock: vi.fn(),
}))

vi.mock('../../api/desktopUiPreferences', async () => {
  const actual = await vi.importActual<typeof import('../../api/desktopUiPreferences')>('../../api/desktopUiPreferences')
  return {
    ...actual,
    desktopUiPreferencesApi: {
      ...actual.desktopUiPreferencesApi,
      getPreferences: getPreferencesMock,
      updatePetPreferences: updatePetPreferencesMock,
    },
  }
})

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    isDesktop: true,
    pets: {
      list: listPetsMock,
      createFromImage: createFromImageMock,
      createFromAtlas: createFromAtlasMock,
      openFolder: openFolderMock,
      show: showPetMock,
      hide: hidePetMock,
      onVisibilityChanged: onVisibilityChangedMock,
    },
  }),
}))

const defaultPetPreferences: DesktopPetPreferences = {
  enabled: false,
  selectedPetId: 'dada-code',
  size: 144,
  showTaskPanel: false,
  collapsed: false,
  motionEnabled: true,
  lastSessionId: null,
}

function preferencesResponse(pet: DesktopPetPreferences) {
  return {
    exists: true,
    preferences: {
      schemaVersion: 4,
      sidebar: {
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: [],
        projectOrganization: 'recentProject' as const,
        projectSortBy: 'updatedAt' as const,
      },
      profile: {
        displayName: 'cc-haha',
        subtitle: '',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet,
    },
  }
}

describe('PetSettings', () => {
  beforeEach(() => {
    let persistedPet = { ...defaultPetPreferences }
    useSettingsStore.setState({ locale: 'en' })
    getPreferencesMock.mockReset()
    updatePetPreferencesMock.mockReset()
    listPetsMock.mockReset()
    createFromImageMock.mockReset()
    createFromAtlasMock.mockReset()
    openFolderMock.mockReset()
    showPetMock.mockReset()
    hidePetMock.mockReset()
    onVisibilityChangedMock.mockReset()

    getPreferencesMock.mockResolvedValue(preferencesResponse(defaultPetPreferences))
    listPetsMock.mockResolvedValue({
      pets: [{
        id: 'custom:moon-cat',
        displayName: 'Moon Cat',
        description: 'A quiet moonlight companion.',
        spriteVersionNumber: 2,
        spritesheetPath: 'spritesheet.webp',
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,AAAA',
      }],
      errors: [{ entry: 'broken-pet', code: 'invalid_manifest', message: 'Invalid manifest' }],
    })
    updatePetPreferencesMock.mockImplementation(async (patch: Partial<DesktopPetPreferences>) => {
      persistedPet = { ...persistedPet, ...patch }
      return {
        ok: true,
        preferences: preferencesResponse(persistedPet).preferences,
      }
    })
    openFolderMock.mockResolvedValue(undefined)
    showPetMock.mockResolvedValue(undefined)
    hidePetMock.mockResolvedValue(undefined)
    onVisibilityChangedMock.mockResolvedValue(() => {})
    createFromImageMock.mockResolvedValue(null)
    createFromAtlasMock.mockResolvedValue(null)
  })

  it('shows built-in and custom pets from the app-owned pet directory', async () => {
    render(<PetSettings />)

    expect(await screen.findByRole('heading', { name: 'Built-in pets' })).toBeInTheDocument()
    expect(screen.getByText('搭搭 Dada')).toBeInTheDocument()
    expect(screen.getByText('弧弧 Huhu')).toBeInTheDocument()
    expect(screen.getByText('补补 Bubu')).toBeInTheDocument()
    expect(screen.getByText('回回 Huihui')).toBeInTheDocument()
    expect(screen.getByText('Moon Cat')).toBeInTheDocument()
    expect(screen.getByText((content) => content.includes('${CLAUDE_CONFIG_DIR:-~/.claude}/cc-haha/pets'))).toBeInTheDocument()
    expect(screen.getByText('1 custom pet folders were skipped because they are invalid.')).toBeInTheDocument()
  })

  it('persists enabling the pet and opens the floating pet window', async () => {
    render(<PetSettings />)

    const toggle = await screen.findByRole('checkbox', { name: 'Show desktop pet' })
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(updatePetPreferencesMock).toHaveBeenCalledWith({
        enabled: true,
      })
    })
    expect(showPetMock).toHaveBeenCalledTimes(1)
    expect(hidePetMock).not.toHaveBeenCalled()
  })

  it('keeps the task panel disabled by default and persists enabling it', async () => {
    render(<PetSettings />)

    const panelToggle = await screen.findByRole('checkbox', { name: 'Show active task panel' })
    expect(panelToggle).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'Start collapsed' })).not.toBeInTheDocument()

    fireEvent.click(panelToggle)

    await waitFor(() => {
      expect(updatePetPreferencesMock).toHaveBeenCalledWith({ showTaskPanel: true })
    })
  })

  it('rolls back optimistic preferences when persistence fails', async () => {
    updatePetPreferencesMock.mockRejectedValueOnce(new Error('disk full'))
    render(<PetSettings />)

    const toggle = await screen.findByRole('checkbox', { name: 'Show desktop pet' })
    fireEvent.click(toggle)

    expect(toggle).toBeChecked()
    expect(await screen.findByRole('alert')).toHaveTextContent('Pet preferences could not be saved.')
    expect(toggle).not.toBeChecked()
    expect(showPetMock).not.toHaveBeenCalled()
  })

  it('rolls back the saved preference when the native pet window cannot open', async () => {
    showPetMock.mockRejectedValueOnce(new Error('window unavailable'))
    render(<PetSettings />)

    const toggle = await screen.findByRole('checkbox', { name: 'Show desktop pet' })
    fireEvent.click(toggle)

    expect(await screen.findByRole('alert')).toHaveTextContent('Pet preferences could not be saved.')
    expect(updatePetPreferencesMock).toHaveBeenNthCalledWith(1, { enabled: true })
    expect(updatePetPreferencesMock).toHaveBeenNthCalledWith(2, { enabled: false })
    expect(toggle).not.toBeChecked()
    expect(hidePetMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes the toggle when the pet window changes preferences separately', async () => {
    getPreferencesMock
      .mockResolvedValueOnce(preferencesResponse({ ...defaultPetPreferences, enabled: true }))
      .mockResolvedValueOnce(preferencesResponse({ ...defaultPetPreferences, enabled: false }))
    render(<PetSettings />)

    const toggle = await screen.findByRole('checkbox', { name: 'Show desktop pet' })
    expect(toggle).toBeChecked()

    window.dispatchEvent(new Event('focus'))

    await waitFor(() => expect(toggle).not.toBeChecked())
  })

  it('refreshes the toggle immediately after the native pet window closes', async () => {
    let notifyVisibilityChanged: (() => void) | undefined
    onVisibilityChangedMock.mockImplementation(async (handler: () => void) => {
      notifyVisibilityChanged = handler
      return () => {}
    })
    getPreferencesMock
      .mockResolvedValueOnce(preferencesResponse({ ...defaultPetPreferences, enabled: true }))
      .mockResolvedValueOnce(preferencesResponse({ ...defaultPetPreferences, enabled: false }))
    render(<PetSettings />)

    const toggle = await screen.findByRole('checkbox', { name: 'Show desktop pet' })
    expect(toggle).toBeChecked()

    notifyVisibilityChanged?.()

    await waitFor(() => expect(toggle).not.toBeChecked())
  })

  it('patches only the pet fields changed by each control', async () => {
    render(<PetSettings />)

    await screen.findByText('Moon Cat')
    const customCard = screen.getByText('Moon Cat').closest('article')
    expect(customCard).not.toBeNull()
    fireEvent.click(customCard!.querySelector('button')!)

    await waitFor(() => {
      expect(updatePetPreferencesMock).toHaveBeenCalledWith({
        selectedPetId: 'custom:moon-cat',
      })
    })

    fireEvent.change(screen.getByRole('slider', { name: 'Pet size' }), { target: { value: '176' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Play animations' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show active task panel' }))

    await waitFor(() => {
      expect(updatePetPreferencesMock).toHaveBeenCalledWith({ size: 176 })
      expect(updatePetPreferencesMock).toHaveBeenCalledWith({ motionEnabled: false })
      expect(updatePetPreferencesMock).toHaveBeenCalledWith({ showTaskPanel: true })
    })
  })

  it('uses the shared theme tokens for selected pet controls', async () => {
    render(<PetSettings />)

    await screen.findByText('Moon Cat')

    const slider = screen.getByRole('slider', { name: 'Pet size' })
    expect(slider).toHaveClass('accent-[var(--color-brand)]')
    expect(slider).not.toHaveClass('accent-[var(--color-accent)]')

    const motionToggle = screen.getByRole('checkbox', { name: 'Play animations' })
    const track = motionToggle.nextElementSibling
    const thumb = track?.nextElementSibling
    expect(track).toHaveClass(
      'peer-checked:bg-[var(--color-switch-checked-bg)]',
      'peer-focus-visible:ring-[var(--color-border-focus)]/40',
    )
    expect(thumb).toHaveClass('bg-[var(--color-switch-thumb)]')

    const selectedCard = screen.getByRole('button', { name: 'Selected' }).closest('article')
    expect(selectedCard).toHaveClass(
      'border-[var(--color-brand)]',
      'bg-[var(--color-surface-selected)]',
    )
  })

  it('opens the app-owned custom pet folder', async () => {
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder' }))

    await waitFor(() => expect(openFolderMock).toHaveBeenCalledTimes(1))
  })

  it('explains the three creation paths without depending on the current chat model', async () => {
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))

    expect(screen.getByRole('button', { name: /Animate one image/ })).toBeEnabled()
    expect(screen.getByText('Local only · No image model or video generation required')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Import professional animation atlas/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Generate full animation with AI/ })).toBeDisabled()
    expect(screen.getByText(/configure a separate image-generation service first/i)).toBeInTheDocument()
    expect(screen.getByText(/current chat model is never used/i)).toBeInTheDocument()
  })

  it('creates a lightweight animated pet from one local image and selects it', async () => {
    createFromImageMock.mockResolvedValueOnce({ id: 'custom:orbit-fox' })
    listPetsMock.mockResolvedValueOnce({ pets: [], errors: [] }).mockResolvedValueOnce({
      pets: [{
        id: 'custom:orbit-fox',
        displayName: 'Orbit Fox',
        description: 'A bright local companion.',
        manifestVersion: 1,
        spriteVersionNumber: 1,
        imagePath: 'pet.webp',
        motionProfile: 'soft-spring-v1',
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,AAAA',
      }],
      errors: [],
    })
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))
    fireEvent.click(screen.getByRole('button', { name: /Animate one image/ }))
    expect(screen.getByText(/lightweight breathing, floating, and task-state motion/i)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'orbit-fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Orbit Fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'A bright local companion.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose image and create' }))

    await waitFor(() => expect(createFromImageMock).toHaveBeenCalledWith({
      slug: 'orbit-fox',
      displayName: 'Orbit Fox',
      description: 'A bright local companion.',
      dialogTitle: 'Choose a transparent pet image',
      dialogFilterName: 'Pet image',
    }))
    expect(createFromAtlasMock).not.toHaveBeenCalled()
    expect(updatePetPreferencesMock).toHaveBeenCalledWith({ selectedPetId: 'custom:orbit-fox' })
    expect(await screen.findByText('Orbit Fox')).toBeInTheDocument()
  })

  it('creates a validated atlas package in app storage and selects it', async () => {
    createFromAtlasMock.mockResolvedValueOnce({ id: 'custom:orbit-fox' })
    listPetsMock.mockResolvedValueOnce({
      pets: [{
        id: 'custom:moon-cat',
        displayName: 'Moon Cat',
        description: 'A quiet moonlight companion.',
        spriteVersionNumber: 2,
        spritesheetPath: 'spritesheet.webp',
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,AAAA',
      }],
      errors: [],
    }).mockResolvedValueOnce({
      pets: [{
        id: 'custom:orbit-fox',
        displayName: 'Orbit Fox',
        description: 'A bright local companion.',
        spriteVersionNumber: 2,
        spritesheetPath: 'spritesheet.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
      }],
      errors: [],
    })
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))
    fireEvent.click(screen.getByRole('button', { name: /Import professional animation atlas/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'orbit-fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Orbit Fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'A bright local companion.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose atlas and create' }))

    await waitFor(() => expect(createFromAtlasMock).toHaveBeenCalledWith({
      slug: 'orbit-fox',
      displayName: 'Orbit Fox',
      description: 'A bright local companion.',
      dialogTitle: 'Choose a v2 pet animation atlas',
      dialogFilterName: 'Pet animation atlas',
    }))
    expect(updatePetPreferencesMock).toHaveBeenCalledWith({ selectedPetId: 'custom:orbit-fox' })
    expect(await screen.findByText('Orbit Fox')).toBeInTheDocument()
  })

  it('keeps the create dialog open and localizes validation failures', async () => {
    createFromAtlasMock.mockResolvedValueOnce({ errorCode: 'invalid-image-dimensions' })
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))
    fireEvent.click(screen.getByRole('button', { name: /Import professional animation atlas/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'bad-atlas' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Bad Atlas' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Needs repair.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose atlas and create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The animation atlas must be exactly 1536×2288 pixels.')
    expect(screen.getByRole('dialog', { name: 'Create a custom pet' })).toBeInTheDocument()
    expect(updatePetPreferencesMock).not.toHaveBeenCalledWith(expect.objectContaining({
      selectedPetId: 'custom:bad-atlas',
    }))
  })

  it('keeps an installed pet visible when selecting it cannot be persisted', async () => {
    createFromAtlasMock.mockResolvedValueOnce({ id: 'custom:orbit-fox' })
    listPetsMock.mockResolvedValueOnce({ pets: [], errors: [] }).mockResolvedValueOnce({
      pets: [{
        id: 'custom:orbit-fox',
        displayName: 'Orbit Fox',
        description: 'A bright local companion.',
        spriteVersionNumber: 2,
        spritesheetPath: 'spritesheet.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
      }],
      errors: [],
    })
    updatePetPreferencesMock.mockRejectedValueOnce(new Error('disk full'))
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))
    fireEvent.click(screen.getByRole('button', { name: /Import professional animation atlas/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'orbit-fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Orbit Fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'A bright local companion.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose atlas and create' }))

    expect(await screen.findByText('Orbit Fox')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Create a custom pet' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Pet preferences could not be saved.')
  })

  it('offers a retry when preferences or the custom catalog cannot be loaded', async () => {
    getPreferencesMock.mockRejectedValueOnce(new Error('server unavailable'))
    render(<PetSettings />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Pets could not be loaded.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('heading', { name: 'Built-in pets' })).toBeInTheDocument()
    expect(getPreferencesMock).toHaveBeenCalledTimes(2)
  })

  it('uses the active locale for native picker labels and image validation', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    createFromImageMock.mockResolvedValueOnce({ errorCode: 'invalid-image-dimensions' })
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: '添加宠物' }))
    fireEvent.click(screen.getByRole('button', { name: /用一张图片制作轻动画/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '宠物 ID' }), { target: { value: 'bad-image' } })
    fireEvent.change(screen.getByRole('textbox', { name: '显示名称' }), { target: { value: 'Bad Image' } })
    fireEvent.change(screen.getByRole('textbox', { name: '宠物描述' }), { target: { value: 'Needs repair.' } })
    fireEvent.click(screen.getByRole('button', { name: '选择图片并创建' }))

    await waitFor(() => expect(createFromImageMock).toHaveBeenCalledWith(expect.objectContaining({
      dialogTitle: '选择透明背景的宠物图片',
      dialogFilterName: '宠物图片',
    })))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '宠物图片每边必须为 32–4096 像素，且总像素数不能超过 16,777,216。',
    )
  })
})
