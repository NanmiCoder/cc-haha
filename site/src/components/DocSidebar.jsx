import React from 'react'
import { toSiteHref } from '../content/docs'

export function DocSidebar({ activeRoute, navigation, onNavigate }) {
  function handleClick(event, route) {
    if (!onNavigate) return
    event.preventDefault()
    onNavigate(route)
  }

  return (
    <aside className="doc-sidebar" aria-label="Documentation navigation">
      <div className="doc-sidebar__eyebrow">Field manual</div>
      <nav>
        {navigation.map((group, index) => (
          <details
            className="doc-sidebar__group"
            key={group.label}
            open={index < 2 || group.items.some((item) => item.route === activeRoute)}
          >
            <summary>
              <span className="doc-sidebar__index">{String(index + 1).padStart(2, '0')}</span>
              {group.label}
            </summary>
            <ul>
              {group.items.map((item) => (
                <li key={item.route}>
                  <a
                    aria-current={item.route === activeRoute ? 'page' : undefined}
                    href={toSiteHref(item.route)}
                    onClick={(event) => handleClick(event, item.route)}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </nav>
    </aside>
  )
}
