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
  importSheetMock,
  writeTextMock,
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
  importSheetMock: vi.fn(),
  writeTextMock: vi.fn(),
  openFolderMock: vi.fn(),
  showPetMock: vi.fn(),
  hidePetMock: vi.fn(),
  onVisibilityChangedMock: vi.fn(),
}))

// The guided import normalizes the sheet on a real canvas, which jsdom does not
// provide. Canvas behaviour is covered by petAtlasNormalize.test.ts instead.
vi.mock('./petSheetImport', () => ({
  importPetFromActionSheet: importSheetMock,
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
    clipboard: { writeText: writeTextMock, readText: vi.fn() },
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
      schemaVersion: 5,
      projectDisplayNames: {},
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
    importSheetMock.mockReset()
    writeTextMock.mockReset()
    writeTextMock.mockResolvedValue(undefined)
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
    expect(screen.getByText('Dada')).toBeInTheDocument()
    expect(screen.getByText('Huhu')).toBeInTheDocument()
    expect(screen.getByText('Bubu')).toBeInTheDocument()
    expect(screen.getByText('Huihui')).toBeInTheDocument()
    expect(screen.getByText('Moon Cat')).toBeInTheDocument()
    expect(screen.getByText((content) => content.includes('${CLAUDE_CONFIG_DIR:-~/.claude}/cc-haha/pets'))).toBeInTheDocument()
    expect(screen.getByText('1 custom pet folders were skipped because they are invalid.')).toBeInTheDocument()
  })

  it('persists enabling the pet and opens the floating pet window', async () => {
    render(<PetSettings />)

    const toggle = await screen.findByRole('switch', { name: 'Show desktop pet' })
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

    const panelToggle = await screen.findByRole('switch', { name: 'Show active task panel' })
    expect(panelToggle).not.toBeChecked()
    expect(screen.queryByRole('switch', { name: 'Start collapsed' })).not.toBeInTheDocument()

    fireEvent.click(panelToggle)

    await waitFor(() => {
      expect(updatePetPreferencesMock).toHaveBeenCalledWith({ showTaskPanel: true })
    })
  })

  it('rolls back optimistic preferences when persistence fails', async () => {
    updatePetPreferencesMock.mockRejectedValueOnce(new Error('disk full'))
    render(<PetSettings />)

    const toggle = await screen.findByRole('switch', { name: 'Show desktop pet' })
    fireEvent.click(toggle)

    expect(toggle).toBeChecked()
    expect(await screen.findByRole('alert')).toHaveTextContent('Pet preferences could not be saved.')
    expect(toggle).not.toBeChecked()
    expect(showPetMock).not.toHaveBeenCalled()
  })

  it('rolls back the saved preference when the native pet window cannot open', async () => {
    showPetMock.mockRejectedValueOnce(new Error('window unavailable'))
    render(<PetSettings />)

    const toggle = await screen.findByRole('switch', { name: 'Show desktop pet' })
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

    const toggle = await screen.findByRole('switch', { name: 'Show desktop pet' })
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

    const toggle = await screen.findByRole('switch', { name: 'Show desktop pet' })
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
    fireEvent.click(screen.getByRole('switch', { name: 'Play animations' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Show active task panel' }))

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

    const motionToggle = screen.getByRole('switch', { name: 'Play animations' })
    const track = motionToggle.nextElementSibling
    const thumb = track?.nextElementSibling
    // The focus ring is the opaque token, not `/40`: the alpha modifier
    // compiles to a color function Safari 15 WebViews drop, and at 40% this
    // ring was barely visible anyway.
    expect(track).toHaveClass(
      'peer-checked:bg-[var(--color-switch-checked-bg)]',
      'peer-focus-visible:ring-[var(--color-border-focus)]',
    )
    expect(thumb).toHaveClass('bg-[var(--color-switch-thumb)]')

    // Selection is a 1.5px terracotta outline over the hover ground, matching
    // the provider list and the worktree cards. The raw `--color-brand` border
    // it used to carry is the accent at full strength, which read as an error
    // outline next to the muted card grid.
    const selectedCard = screen.getByRole('button', { name: 'Selected' }).closest('article')
    expect(selectedCard).toHaveClass(
      'border-[1.5px]',
      'border-[var(--color-primary-fixed-dim)]',
      'bg-[var(--color-surface-hover)]',
    )
  })

  it('opens the app-owned custom pet folder', async () => {
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder' }))

    await waitFor(() => expect(openFolderMock).toHaveBeenCalledTimes(1))
  })

  it('offers three usable creation paths with no disabled dead end', async () => {
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))

    expect(screen.getByRole('button', { name: /Use a picture you already have/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Draw one with AI that runs and jumps/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /I already have an action sheet/ })).toBeEnabled()
    expect(screen.getByText(/none of your chat quota is used/i)).toBeInTheDocument()
  })

  it('walks the AI path through the prompt and template before asking for a file', async () => {
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))
    fireEvent.click(screen.getByRole('button', { name: /Draw one with AI that runs and jumps/ }))

    // Step 1 hands over a prompt the user can paste straight into an image model.
    expect(screen.getByText(/Draw me a game character action sheet/)).toBeInTheDocument()
    expect(screen.getByText(/8 columns x 9 rows/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Copy this prompt/ }))
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(
      expect.stringContaining('Row 2, all 8 cells'),
    ))

    // Step 2 shows the reference grid rather than describing pixel maths.
    expect(screen.getByRole('img', { name: /Action sheet template/ })).toBeInTheDocument()
    expect(screen.getByText(/a white backdrop becomes a square/i)).toBeInTheDocument()

    // The form only appears once the walkthrough is acknowledged.
    expect(screen.queryByRole('textbox', { name: 'Pet ID' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done drawing, next' }))
    expect(screen.getByRole('textbox', { name: 'Pet ID' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to the steps' })).toBeInTheDocument()
    // The form must stay badged as the AI path, not fall through to the "already
    // have a sheet" heading.
    expect(screen.getByRole('heading', { name: /Draw one with AI that runs and jumps/ }))
      .toBeInTheDocument()
  })

  it('tells the user plainly when the sheet has no transparent background', async () => {
    importSheetMock.mockResolvedValueOnce({ status: 'error', errorCode: 'opaque-background' })
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))
    fireEvent.click(screen.getByRole('button', { name: /I already have an action sheet/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'flat-cat' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Flat Cat' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Needs alpha.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pick an action sheet' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no transparent background, so the pet would show up as a square/i,
    )
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
    fireEvent.click(screen.getByRole('button', { name: /Use a picture you already have/ }))
    expect(screen.getByText(/only sways gently/i)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'orbit-fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Orbit Fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'A bright local companion.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick a picture' }))

    await waitFor(() => expect(createFromImageMock).toHaveBeenCalledWith({
      slug: 'orbit-fox',
      displayName: 'Orbit Fox',
      description: 'A bright local companion.',
      dialogTitle: 'Choose a pet image with a transparent background',
      dialogFilterName: 'Pet image',
    }))
    expect(importSheetMock).not.toHaveBeenCalled()
    expect(updatePetPreferencesMock).toHaveBeenCalledWith({ selectedPetId: 'custom:orbit-fox' })
    expect(await screen.findByText('Orbit Fox')).toBeInTheDocument()
  })

  it('creates a validated atlas package in app storage and selects it', async () => {
    importSheetMock.mockResolvedValueOnce({ status: 'created', id: 'custom:orbit-fox' })
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
    fireEvent.click(screen.getByRole('button', { name: /I already have an action sheet/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'orbit-fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Orbit Fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'A bright local companion.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick an action sheet' }))

    await waitFor(() => expect(importSheetMock).toHaveBeenCalledWith(expect.anything(), {
      slug: 'orbit-fox',
      displayName: 'Orbit Fox',
      description: 'A bright local companion.',
      dialogTitle: 'Choose a pet action sheet',
      dialogFilterName: 'Pet action sheet',
    }))
    expect(updatePetPreferencesMock).toHaveBeenCalledWith({ selectedPetId: 'custom:orbit-fox' })
    expect(await screen.findByText('Orbit Fox')).toBeInTheDocument()
  })

  it('keeps the create dialog open and localizes validation failures', async () => {
    importSheetMock.mockResolvedValueOnce({ status: 'error', errorCode: 'invalid-image-dimensions' })
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))
    fireEvent.click(screen.getByRole('button', { name: /I already have an action sheet/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'bad-atlas' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Bad Atlas' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Needs repair.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pick an action sheet' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /cannot be sliced into 8 columns by 9 rows/i,
    )
    expect(screen.getByRole('dialog', { name: 'Make your own pet' })).toBeInTheDocument()
    expect(updatePetPreferencesMock).not.toHaveBeenCalledWith(expect.objectContaining({
      selectedPetId: 'custom:bad-atlas',
    }))
  })

  it('keeps an installed pet visible when selecting it cannot be persisted', async () => {
    importSheetMock.mockResolvedValueOnce({ status: 'created', id: 'custom:orbit-fox' })
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
    fireEvent.click(screen.getByRole('button', { name: /I already have an action sheet/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'orbit-fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Orbit Fox' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'A bright local companion.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pick an action sheet' }))

    expect(await screen.findByText('Orbit Fox')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Make your own pet' })).not.toBeInTheDocument()
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
    useSettingsStore.setState({ locale: 'en' })
    createFromImageMock.mockResolvedValueOnce({ errorCode: 'invalid-image-dimensions' })
    render(<PetSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add pet' }))
    fireEvent.click(screen.getByRole('button', { name: /Use a picture you already have/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Pet ID' }), { target: { value: 'bad-image' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Bad Image' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Needs repair.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pick a picture' }))

    await waitFor(() => expect(createFromImageMock).toHaveBeenCalledWith(expect.objectContaining({
      dialogTitle: 'Choose a pet image with a transparent background',
      dialogFilterName: 'Pet image',
    })))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The image must be 32–4096 pixels per side and contain no more than 16,777,216 pixels.',
    )
  })
})
