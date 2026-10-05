import { Fragment, type ReactNode } from 'react'

export type SessionHeaderMetaItem = {
  key: string
  content: ReactNode
}

export function SessionChatHeader({
  title,
  compact = false,
  leading,
  titleAddon,
  actions,
  metadata = [],
  children,
}: {
  title: string
  compact?: boolean
  leading?: ReactNode
  titleAddon?: ReactNode
  actions?: ReactNode
  metadata?: SessionHeaderMetaItem[]
  children?: ReactNode
}) {
  return (
    <div
      data-testid="session-header"
      className={[
        'w-full border-b border-[var(--color-border)]',
        compact ? 'px-4 py-2.5' : 'px-7 py-3.5',
      ].join(' ')}
    >
      <div className="mx-auto w-full min-w-0 max-w-[var(--chat-content-max-width)]">
        {/* Top-aligned so a goal / team strip below the meta line does not drag
            the actions down; they are offset to centre on title + meta. */}
        <div className="flex min-w-0 items-start gap-4">
          {leading}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1
                className="min-w-0 truncate text-[15px] font-semibold leading-[1.35] tracking-[-0.01em] text-[var(--color-text-primary)]"
                style={{ fontFamily: 'var(--font-headline)' }}
                title={title}
              >
                {title}
              </h1>
              {titleAddon}
            </div>
            {metadata.length > 0 ? (
              <div className="mt-[3px] flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-[var(--color-text-tertiary)] [&_svg]:shrink-0">
                {metadata.map((item, index) => (
                  <Fragment key={item.key}>
                    {index > 0 ? (
                      <span aria-hidden="true" className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--color-text-tertiary)]" />
                    ) : null}
                    {item.content}
                  </Fragment>
                ))}
              </div>
            ) : null}
            {children}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div> : null}
        </div>
      </div>
    </div>
  )
}

export function SessionChatSurface({
  surfaceKind,
  agentRunKind,
  isMobileLayout,
  compact = false,
  activityRailOpen = false,
  contentRowTestId = 'session-chat-content-row',
  chatColumnTestId = 'session-chat-column',
  compactColumnClassName,
  children,
  activityRail,
  sidePanel,
  overlay,
  chatColumnHidden = false,
}: {
  surfaceKind: 'main' | 'agent'
  agentRunKind?: 'subagent' | 'team-member'
  isMobileLayout: boolean
  compact?: boolean
  activityRailOpen?: boolean
  contentRowTestId?: string
  chatColumnTestId?: string
  compactColumnClassName?: string
  children: ReactNode
  activityRail?: ReactNode
  sidePanel?: ReactNode
  overlay?: ReactNode
  /**
   * Maximised workspace. The column is hidden rather than unmounted so the
   * conversation keeps its scroll position, its draft and its subscriptions —
   * restoring the split has to come back to exactly what was there.
   */
  chatColumnHidden?: boolean
}) {
  return (
    <div
      data-testid="session-chat-surface"
      data-session-chat-kind={surfaceKind}
      data-agent-run-kind={agentRunKind}
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background text-on-surface"
    >
      <div data-testid={contentRowTestId} className="flex min-h-0 min-w-0 flex-1">
        <div
          data-testid={chatColumnTestId}
          className={[
            'relative flex min-h-0 min-w-0 flex-col overflow-hidden',
            'transition-[padding] duration-200 ease-out motion-reduce:transition-none',
            activityRailOpen ? 'pr-[352px]' : '',
            chatColumnHidden ? 'hidden' : '',
            compact
              ? compactColumnClassName ?? 'min-w-[400px] flex-1 bg-[var(--color-surface)]'
              : isMobileLayout
                ? 'flex-1'
                : 'min-w-[360px] flex-1',
          ].filter(Boolean).join(' ')}
        >
          {children}
        </div>
        {activityRail}
        {sidePanel}
      </div>
      {overlay}
    </div>
  )
}
