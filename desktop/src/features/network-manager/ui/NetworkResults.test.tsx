import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { createNetworkFixture } from '../testing/networkFixture'
import { NetworkResults } from './NetworkResults'

afterEach(cleanup)
it('distinguishes configured state from a successful probe and shows its source and timestamp', () => {
  useSettingsStore.setState({ locale: 'en' })
  const fixture = createNetworkFixture()
  const { rerender } = render(<NetworkResults snapshot={fixture.snapshot} plan={fixture.plan} report={null} probes={[]} />)
  expect(screen.queryByText('Verified')).toBeNull()
  expect(screen.getByText('VPN split tunneling or associated routes need changes')).toBeVisible()
  rerender(<NetworkResults snapshot={fixture.snapshot} plan={null} report={null} probes={[fixture.probe]} />)
  expect(screen.getByText('Verified')).toBeVisible()
  expect(screen.getByText('Source: 191.168.7.10 · Fixture Ethernet')).toBeVisible()
  expect(screen.getByText('Fixture TCP connected')).toBeVisible()
})
