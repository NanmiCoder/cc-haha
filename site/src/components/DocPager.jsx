import React from 'react'
import { toSiteHref } from '../content/docs'

export function DocPager({ next, onNavigate, previous }) {
  function handleClick(event, route) {
    if (!onNavigate) return
    event.preventDefault()
    onNavigate(route)
  }

  if (!previous && !next) return null

  return (
    <nav className="doc-pager" aria-label="Adjacent documentation">
      {previous ? (
        <a href={toSiteHref(previous.route)} onClick={(event) => handleClick(event, previous.route)}>
          <small>← Previous</small>
          <span>{previous.title}</span>
        </a>
      ) : <span />}
      {next ? (
        <a href={toSiteHref(next.route)} onClick={(event) => handleClick(event, next.route)}>
          <small>Next →</small>
          <span>{next.title}</span>
        </a>
      ) : <span />}
    </nav>
  )
}
