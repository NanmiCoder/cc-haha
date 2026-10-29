import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { MobileAppInstall } from './MobileAppInstall'

beforeEach(() => useSettingsStore.setState({ locale: 'en' }))
afterEach(cleanup)

it('shows the native app release status without offering unverified downloads or installation QR codes', () => {
  const onUseBrowser = vi.fn()
  const { container } = render(<MobileAppInstall connectionMethodsId="connection-methods" onUseBrowser={onUseBrowser} />)
  expect(screen.getByRole('heading', { name: 'Get cc-haha on your phone' })).toBeVisible()
  expect(screen.getByText('Not released')).toBeVisible()
  expect(screen.getByText('Not open yet')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Download Android APK' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Join TestFlight beta' })).toBeDisabled()
  expect(container.querySelector('a, img')).toBeNull()
  expect(onUseBrowser).not.toHaveBeenCalled()
})

it('offers a working browser connection action while native distribution is pending', () => {
  const onUseBrowser = vi.fn()
  render(<MobileAppInstall connectionMethodsId="connection-methods" onUseBrowser={onUseBrowser} />)
  const button = screen.getByRole('button', { name: 'Use phone browser' })
  expect(button).toHaveAttribute('aria-controls', 'connection-methods')
  expect(button).not.toBeDisabled()
  fireEvent.click(button)
  expect(onUseBrowser).toHaveBeenCalledTimes(1)
  expect(screen.getByText(/Same-Wi-Fi and Cloudflare connections/)).toBeVisible()
  expect(screen.getByText(/No extra VPN app is needed/)).toBeVisible()
})
