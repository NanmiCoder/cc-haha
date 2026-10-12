import type { MouseEventHandler, Ref } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import type { PetSessionActivity } from './petSessionModel'

type PetActivityPanelProps = {
  activities: readonly PetSessionActivity[]
  permissions: boolean
  error: string | null
  cardRef: Ref<HTMLElement>
  toggleRef: Ref<HTMLButtonElement>
  onCollapse: () => void
  onMouseEnter: MouseEventHandler<HTMLElement>
  onMouseLeave: MouseEventHandler<HTMLElement>
}

export function PetActivityPanel({
  activities,
  permissions,
  error,
  cardRef,
  toggleRef,
  onCollapse,
  onMouseEnter,
  onMouseLeave,
}: PetActivityPanelProps) {
  const t = useTranslation()
  const label = t(permissions ? 'pet.window.permissionCount' : 'pet.window.sessionCount', {
    count: activities.length,
  })

  return (
    <section
      id="pet-activity-panel"
      ref={cardRef}
      className="pet-activity-card"
      data-expanded="true"
      data-panel-kind={permissions ? 'permissions' : 'tasks'}
      aria-label={label}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {error && (
        <p
          role="alert"
          className="mx-3 mt-2 rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-xs text-[var(--color-on-error-container)]"
        >
          {error}
        </p>
      )}

      <div
        className="pet-session-list"
        data-expanded="true"
        role="list"
        aria-live="polite"
        aria-label={label}
      >
        {activities.map((activity) => {
          const title = activity.session.title || t('pet.window.untitledSession')
          const status = t(`pet.window.status.${activity.status}` as Parameters<typeof t>[0])
          return (
            <div role="listitem" key={activity.session.id}>
              <button
                type="button"
                className="pet-session-row"
                aria-label={`${title}, ${status}`}
                onClick={() => void getDesktopHost().pets.focusSession(activity.session.id)}
              >
                <span className="pet-session-copy">
                  <span className="pet-session-title">{title}</span>
                  <span className="pet-session-status">{status}</span>
                </span>
                <span className={`pet-session-indicator is-${activity.status}`} />
              </button>
            </div>
          )
        })}
      </div>

      <button
        ref={toggleRef}
        type="button"
        className="pet-panel-toggle"
        data-expanded="true"
        aria-label={t(permissions ? 'pet.window.hidePermissions' : 'pet.window.hideTasks', {
          count: activities.length,
        })}
        aria-expanded="true"
        aria-controls="pet-activity-panel"
        onClick={onCollapse}
      >
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </section>
  )
}
