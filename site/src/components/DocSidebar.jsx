import { useEffect, useRef, useState } from 'react'
import { toSiteHref } from '../content/docs'
import Icon from './icons'

export function DocSidebar({ activeRoute, label = 'Documentation', locale = 'zh', navigation, onNavigate, onRequestClose, open }) {
  const scope = useRef(null)
  const activeGroup = navigation.find(group => group.items.some(item => item.route === activeRoute))?.id
  const [expanded, setExpanded] = useState(() => new Set([activeGroup]))

  useEffect(() => {
    setExpanded(current => new Set([...current, activeGroup]))
  }, [activeGroup, activeRoute])
  useEffect(() => {
    const node = scope.current?.querySelector('[aria-current="page"]')
    const list = scope.current
    if (!node || !list) return
    const item = node.getBoundingClientRect()
    const box = list.getBoundingClientRect()
    if (item.top < box.top) list.scrollTop -= box.top - item.top
    else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom
  }, [activeRoute, expanded])

  useEffect(() => {
    if (!open) return undefined
    const opener = document.activeElement
    const target = scope.current?.querySelector('[aria-current="page"]') || scope.current?.querySelector('button')
    target?.focus()
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
    }
  }, [open])

  function onKeyDown(event) {
    if (!open || event.key !== 'Tab') return
    const stops = [...(scope.current?.querySelectorAll('a[href], button') || [])].filter(node => node.getClientRects().length > 0)
    if (!stops.length) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return <nav aria-label={label} className="doc-nav" data-open={open} id="doc-nav" onKeyDown={onKeyDown} ref={scope}>
    <div className="doc-nav__intro"><span>cc-haha</span><strong>{locale === 'en' ? 'A field guide to\nbetter work.' : '让每一个想法，\n找到实现的路径。'}</strong><small>{locale === 'en' ? 'EXPLORE AT YOUR OWN PACE' : '按你的节奏，慢慢探索'}</small></div>
    <div className="doc-nav__mobile-heading"><span>{label}</span><button aria-label={locale === 'en' ? 'Close contents' : '关闭目录'} onClick={onRequestClose} type="button"><Icon name="close" /></button></div>
    {navigation.map((group, index) => <div className="doc-nav__group" key={group.id}>
      <button className="doc-nav__title" aria-expanded={expanded.has(group.id)} aria-controls={`doc-group-${group.id}`} onClick={() => setExpanded(current => { const next=new Set(current); next.has(group.id) ? next.delete(group.id) : next.add(group.id); return next })} type="button"><span className="doc-nav__number">0{index + 1}</span><span>{group.label}</span><span className="doc-nav__chevron" aria-hidden="true">⌄</span></button>
      <ul className="doc-nav__list" id={`doc-group-${group.id}`} hidden={!expanded.has(group.id)}>{group.items.map(item => <li key={item.route}>
        <a aria-current={item.route === activeRoute ? 'page' : undefined} className="doc-nav__link" href={toSiteHref(item.route)} onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          onNavigate(item.route)
          onRequestClose?.()
        }} title={item.title}>{item.label}</a>
      </li>)}</ul>
    </div>)}
  </nav>
}

export default DocSidebar
