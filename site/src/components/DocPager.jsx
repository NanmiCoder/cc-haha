import { toSiteHref } from '../content/docs'

const copy = { label: 'Previous and next page', next: 'Next', previous: 'Previous' }

export function DocPager({ next, onNavigate, previous }) {
  if (!previous && !next) return null
  const c = copy

  const link = (doc, direction) => (
    <a
      className={`doc-pager__link doc-pager__link--${direction}`}
      href={toSiteHref(doc.route)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return
        event.preventDefault()
        onNavigate(doc.route)
      }}
    >
      <span className="doc-pager__dir">{direction === 'next' ? c.next : c.previous}</span>
      <span className="doc-pager__title">{doc.label}</span>
      {doc.section && <span className="doc-pager__section">{doc.section}</span>}
    </a>
  )

  return (
    <nav aria-label={c.label} className="doc-pager">
      {previous ? link(previous, 'previous') : <span />}
      {next && link(next, 'next')}
    </nav>
  )
}

export default DocPager
