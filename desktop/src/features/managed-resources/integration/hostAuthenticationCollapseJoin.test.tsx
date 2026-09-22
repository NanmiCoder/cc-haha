import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { createApplicationOperationsHarness } from '../../../test/applicationOperationsHarness'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useHostManagementStore } from '../stores/hostManagementStore'
import { HostDetail } from '../ui/hosts/HostDetail'

let h: Awaited<ReturnType<typeof createApplicationOperationsHarness>>
const toggle = () => screen.getByRole('button', { name: 'Auth Method' })
const body = () => document.getElementById(toggle().getAttribute('aria-controls')!)!
const reveal = () => within(body()).getByRole('button', { name: /verify.*reveal/i })

beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  useSettingsStore.setState({ locale: 'en' })
  h = await createApplicationOperationsHarness()
  // Native identity prompts must never run in a test. Only this OS boundary is faked.
  h.fixture.services.credentialRevealAuthorizer = { authorize: vi.fn(async () => ({ status: 'authorized' as const })) }
})
afterEach(async () => { cleanup(); await h?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('host authentication disclosure through production HostDetail and DesktopHost/IPC', () => {
  it('keeps host summary metadata on one row and gives the terminal the remaining panel height contract', () => {
    render(<HostDetail />)
    const summary = screen.getByTestId('host-summary-line')
    expect(summary).toHaveClass('whitespace-nowrap', 'overflow-hidden')
    expect(screen.getByTestId('host-summary-name')).toHaveTextContent(h.host.name)
    expect(screen.getByTestId('host-summary-endpoint')).toHaveTextContent(`${h.host.username}@${h.host.address}:${h.host.port}`)
    expect(screen.getByTestId('host-detail')).toHaveClass('h-full', 'min-h-0', 'overflow-hidden')
    expect(screen.getByTestId('host-connection-workspace')).toHaveClass('flex-1', 'min-h-0', 'overflow-hidden')
    expect(screen.getByTestId('host-terminal-panel')).toHaveClass('flex-1', 'min-h-0')
    expect(screen.getByTestId('ssh-console')).toHaveClass('h-full', 'min-h-0', 'flex', 'flex-col')
    expect(screen.getByTestId('ssh-terminal-viewport')).toHaveClass('flex-1', 'min-h-0')
  })

  it('defaults to collapsed while all workspace tabs stay reachable and the SSH connection stays alive', async () => {
    render(<HostDetail />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(body()).not.toBeVisible()
    expect(screen.queryByRole('button', { name: /verify.*reveal/i })).not.toBeInTheDocument()
    for (const tab of ['host-terminal-tab', 'host-files-tab', 'host-applications-tab', 'host-java-tab']) expect(screen.getByTestId(tab)).toBeVisible()
    const connection = h.ssh().connectionId
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(body()).toBeVisible()
    expect(body()).toHaveTextContent(h.root)
    expect(reveal()).toBeEnabled()
    fireEvent.click(toggle())
    fireEvent.click(screen.getByTestId('host-applications-tab'))
    await screen.findByTestId('application-file-lists')
    expect(h.ssh().connectionId).toBe(connection)
    expect(h.ssh().status).toBe('ready')
    expect(h.fixture.services.credentialRevealAuthorizer!.authorize).not.toHaveBeenCalled()
    expect(h.commands).toHaveLength(0)
  })

  it('discards a revealed password when collapsed and requires verification again after reopening', async () => {
    const call = vi.spyOn(h.fixture.host.hostManagement, 'revealCredential')
    render(<HostDetail />)
    fireEvent.click(toggle())
    fireEvent.click(reveal())
    await waitFor(() => expect(body()).toHaveTextContent('APP_OPS_FIXTURE_ONLY'))
    expect(call).toHaveBeenCalledWith(h.host.auth.credentialId)
    fireEvent.click(toggle())
    expect(document.body).not.toHaveTextContent('APP_OPS_FIXTURE_ONLY')
    fireEvent.click(toggle())
    expect(body()).not.toHaveTextContent('APP_OPS_FIXTURE_ONLY')
    expect(body()).toHaveTextContent('••••••••')
    expect(h.fixture.services.credentialRevealAuthorizer!.authorize).toHaveBeenCalledTimes(1)
    fireEvent.click(reveal())
    await waitFor(() => expect(body()).toHaveTextContent('APP_OPS_FIXTURE_ONLY'))
    expect(h.fixture.services.credentialRevealAuthorizer!.authorize).toHaveBeenCalledTimes(2)
  })

  it('ignores a late verification result after the section is closed and reopened', async () => {
    let resolve!: (value: { status: 'authorized' }) => void
    const pending = new Promise<{ status: 'authorized' }>(done => { resolve = done })
    h.fixture.services.credentialRevealAuthorizer = { authorize: vi.fn(() => pending) }
    const call = vi.spyOn(h.fixture.host.hostManagement, 'revealCredential')
    render(<HostDetail />)
    fireEvent.click(toggle())
    fireEvent.click(reveal())
    await waitFor(() => expect(h.fixture.services.credentialRevealAuthorizer!.authorize).toHaveBeenCalledTimes(1))
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    await act(async () => { resolve({ status: 'authorized' }); await call.mock.results[0]!.value })
    expect(body()).not.toHaveTextContent('APP_OPS_FIXTURE_ONLY')
    expect(reveal()).toBeEnabled()
    expect(body()).toHaveTextContent('••••••••')
  })

  it('keeps verification failures masked without changing the authentication requirements', async () => {
    h.fixture.services.credentialRevealAuthorizer = { authorize: vi.fn(async () => ({ status: 'denied' as const })) }
    render(<HostDetail />)
    fireEvent.click(toggle())
    fireEvent.click(reveal())
    await within(body()).findByRole('alert')
    expect(body()).not.toHaveTextContent('APP_OPS_FIXTURE_ONLY')
    expect(body()).toHaveTextContent('••••••••')
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect(within(body()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('starts collapsed on another host and when the host details are reopened', async () => {
    const view = render(<HostDetail />)
    fireEvent.click(toggle())
    const created = await useHostManagementStore.getState().saveHost({
      name: 'Other authentication fixture', address: '127.0.0.1', port: 22, username: 'fixture',
      auth: { type: 'password', credentialId: null }, tagIds: [], initialDirectory: '/other-fixture', notes: '', applications: [],
    })
    if (!created.success) throw new Error('Unable to create fixture host')
    act(() => useHostManagementStore.getState().setSelectedHostId(created.host.id))
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle())
    expect(body()).toHaveTextContent('/other-fixture')
    expect(within(body()).queryByRole('button', { name: /verify.*reveal/i })).not.toBeInTheDocument()
    act(() => useHostManagementStore.getState().setSelectedHostId(h.host.id))
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle())
    view.unmount()
    render(<HostDetail />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })
})
