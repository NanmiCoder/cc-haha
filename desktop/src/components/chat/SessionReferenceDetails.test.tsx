import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import '@testing-library/jest-dom'
import { SessionReferenceDetails } from '@/components/chat/SessionReferenceDetails'
import { ComposerSuggestionRow } from '@/components/chat/ComposerSuggestionRow'
import { translate, type Locale } from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'

it.each<Locale>(['en', 'zh', 'zh-TW', 'jp', 'kr'])('localizes status and project fallback in %s without exposing an invalid date', locale => {
  useSettingsStore.setState({ locale })
  render(<ComposerSuggestionRow id="session" label="会话标题" details={<SessionReferenceDetails shortId="0123abcd" session={{ sessionId: '0123abcd-rest', title: '会话标题', cwd: '', status: 'blocked', updatedAt: 'invalid' }} />} />)
  expect(screen.getByRole('option')).toHaveAccessibleName('会话标题')
  expect(screen.getByRole('option')).toHaveAccessibleDescription(expect.stringContaining(translate(locale, 'chat.collaborationBlocked')))
  expect(screen.getByRole('option')).toHaveAccessibleDescription(expect.stringContaining(translate(locale, 'chat.sessionNoProject')))
  expect(screen.getByText('0123abcd')).toHaveAttribute('title', '0123abcd-rest')
  expect(document.querySelector('time')).toBeNull()
})

it('keeps full project and stable ID available while shortening visual metadata', () => {
  useSettingsStore.setState({ locale: 'en' })
  const cwd = 'C:\\workspace\\产品研发\\桌面项目'
  render(<ComposerSuggestionRow id="session" label="评审" details={<SessionReferenceDetails shortId="same-prefix-but-unique" session={{ sessionId: 'same-prefix-but-unique', title: '评审', cwd, status: 'idle', updatedAt: '2026-09-20T12:34:00Z' }} />} />)
  expect(screen.getByText('产品研发/桌面项目')).toBeInTheDocument()
  expect(screen.getByRole('option')).toHaveAccessibleDescription(expect.stringContaining(cwd))
  expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-09-20T12:34:00Z')
})
