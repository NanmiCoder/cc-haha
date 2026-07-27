import { useEffect, useState } from 'react'
import Icon from '../../components/icons'
import SiteHeader, { DOWNLOAD_URL, GITHUB_URL } from '../../components/SiteHeader'
import { toSiteHref } from '../../content/docs'
import { setPageMeta } from '../../lib/meta'
import { content, mascotAccents, mascots } from './content'
import './home.css'

const SOURCE_COMMANDS = [
  'git clone https://github.com/NanmiCoder/cc-haha.git',
  'cd cc-haha && bun install',
  './bin/claude-haha'
]

function Hero({ c, locale }) {
  return (
    <section className="hero">
      <div className="u-shell hero__inner">
        <div className="hero__copy">
          <h1>{c.hero.title}</h1>
          <p className="u-lede">{c.hero.lede}</p>
          <div className="hero__actions">
            <a className="btn btn--primary btn--lg" href={DOWNLOAD_URL}>
              <Icon name="download" size={17} />
              {c.hero.primary}
            </a>
            <a
              className="btn btn--ghost btn--lg"
              href={toSiteHref(locale === 'en' ? '/en/start/first-session' : '/start/first-session')}
            >
              {c.hero.secondary}
              <Icon name="arrow" size={17} />
            </a>
          </div>
          <ul className="hero__badges">
            {c.hero.badges.map((badge) => <li key={badge}>{badge}</li>)}
          </ul>
        </div>

        <figure className="hero__figure">
          <img
            alt={c.tour.tabs[0].title}
            fetchPriority="high"
            height="1436"
            src={c.tour.tabs[0].image}
            width="2000"
          />
          <figcaption>{c.hero.caption}</figcaption>
        </figure>
      </div>
    </section>
  )
}

function Capabilities({ c }) {
  return (
    <section className="section" id="capabilities">
      <div className="u-shell">
        <header className="section__head">
          <h2>{c.capabilities.title}</h2>
          <p className="u-lede">{c.capabilities.lede}</p>
        </header>
        <ul className="cap-grid">
          {c.capabilities.items.map(([title, body]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Tour({ c, locale }) {
  const [activeId, setActiveId] = useState(c.tour.tabs[0].id)
  useEffect(() => setActiveId(c.tour.tabs[0].id), [c])

  const active = c.tour.tabs.find((tab) => tab.id === activeId) || c.tour.tabs[0]

  function onKeyDown(event, index) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()

    const count = c.tour.tabs.length
    let next = index
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = count - 1
    if (event.key === 'ArrowLeft') next = (index - 1 + count) % count
    if (event.key === 'ArrowRight') next = (index + 1) % count

    setActiveId(c.tour.tabs[next].id)
    event.currentTarget.parentElement?.querySelector(`#tour-${c.tour.tabs[next].id}`)?.focus()
  }

  return (
    <section className="section section--muted" id="tour">
      <div className="u-shell">
        <header className="section__head">
          <h2>{c.tour.title}</h2>
          <p className="u-lede">{c.tour.lede}</p>
        </header>

        <div
          aria-label={locale === 'en' ? 'Product tour' : '产品巡览'}
          className="tour__tabs"
          role="tablist"
        >
          {c.tour.tabs.map((tab, index) => (
            <button
              aria-controls={`tourpanel-${tab.id}`}
              aria-selected={tab.id === active.id}
              className="tour__tab"
              id={`tour-${tab.id}`}
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              role="tab"
              tabIndex={tab.id === active.id ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div
          aria-labelledby={`tour-${active.id}`}
          className="tour__panel"
          id={`tourpanel-${active.id}`}
          role="tabpanel"
          tabIndex={0}
        >
          <div className="tour__copy">
            <h3>{active.title}</h3>
            <p>{active.body}</p>
          </div>
          <div className={active.id === 'remote' ? 'tour__shot tour__shot--tall' : 'tour__shot'}>
            <img alt={active.title} key={active.id} loading="lazy" src={active.image} />
          </div>
        </div>
      </div>
    </section>
  )
}

function Crew({ c, locale }) {
  return (
    <section className="section" id="crew">
      <div className="u-shell crew">
        <div className="crew__intro">
          <h2>{c.crew.title}</h2>
          <p className="u-lede">{c.crew.lede}</p>
          <a className="link-arrow" href={toSiteHref(locale === 'en' ? '/en/desktop/pets' : '/desktop/pets')}>
            {c.crew.link}
            <Icon name="arrow" size={16} />
          </a>
        </div>
        <ul className="crew__grid">
          {c.crew.members.map(([name, latin, role, body], index) => (
            <li key={latin} style={{ '--accent': mascotAccents[index] }}>
              <img alt="" loading="lazy" src={mascots[index]} />
              <span className="crew__role">{role}</span>
              <h3>{name}{name !== latin && <em>{latin}</em>}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Paths({ c }) {
  return (
    <section className="section section--muted" id="docs">
      <div className="u-shell">
        <header className="section__head">
          <h2>{c.paths.title}</h2>
          <p className="u-lede">{c.paths.lede}</p>
        </header>
        <div className="paths">
          {c.paths.items.map((item) => (
            <article className="path-card" key={item.title}>
              <span className="path-card__eyebrow">{item.eyebrow}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              <ul>
                {item.links.map(([href, label]) => (
                  <li key={href}>
                    <a href={toSiteHref(href)}>
                      {label}
                      <Icon name="arrow" size={16} />
                    </a>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function Install({ c, locale }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(SOURCE_COMMANDS.join('\n'))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 剪贴板被禁用时静默失败，命令仍然可以手选复制 */
    }
  }

  return (
    <section className="section" id="install">
      <div className="u-shell install">
        <div className="install__copy">
          <h2>{c.install.title}</h2>
          <p className="u-lede">{c.install.lede}</p>
          <div className="install__actions">
            <a className="btn btn--primary btn--lg" href={DOWNLOAD_URL}>
              <Icon name="download" size={17} />
              {c.install.primary}
            </a>
            <a
              className="link-arrow"
              href={toSiteHref(locale === 'en' ? '/en/start/troubleshooting' : '/start/troubleshooting')}
            >
              {c.install.docs}
              <Icon name="arrow" size={16} />
            </a>
          </div>
        </div>

        <div className="install__terminal">
          <div className="install__terminal-head">
            <span>{c.install.commandLabel}</span>
            <button onClick={copy} type="button">
              <Icon name={copied ? 'check' : 'copy'} size={15} />
              {copied ? c.install.copied : c.install.copy}
            </button>
          </div>
          <pre><code>{SOURCE_COMMANDS.map((line) => `$ ${line}`).join('\n')}</code></pre>
        </div>
      </div>
    </section>
  )
}

function Footer({ c, locale }) {
  return (
    <footer className="site-footer">
      <div className="u-shell site-footer__inner">
        <div className="site-footer__brand">
          <img alt="" src={toSiteHref('/images/app-icon.png')} width="30" height="30" />
          <strong>Claude Code Haha</strong>
          <p>{c.footer.tagline}</p>
          <a className="link-arrow" href={GITHUB_URL} rel="noreferrer" target="_blank">
            <Icon name="github" size={16} />
            GitHub
          </a>
        </div>
        {c.footer.columns.map(([title, links]) => (
          // 页脚栏目名和头部导航会撞车，加个前缀让地标列表能区分。
          <nav aria-label={`${locale === 'en' ? 'Footer' : '页脚'} · ${title}`} key={title}>
            <h2 className="site-footer__title">{title}</h2>
            <ul>
              {links.map(([href, label]) => (
                <li key={href}><a href={toSiteHref(href)}>{label}</a></li>
              ))}
            </ul>
          </nav>
        ))}
        <div className="site-footer__meta">
          <a href={toSiteHref(locale === 'en' ? '/' : '/en')}>{locale === 'en' ? '中文' : 'English'}</a>
        </div>
      </div>
    </footer>
  )
}

export default function HomePage({ locale = 'zh' }) {
  const c = content[locale] || content.zh

  useEffect(() => {
    setPageMeta({
      alternate: locale === 'en' ? '/' : '/en',
      canonical: locale === 'en' ? '/en' : '/',
      description: c.hero.lede,
      lang: locale === 'en' ? 'en' : 'zh-CN',
      title: locale === 'en'
        ? 'Claude Code Haha — a local-first desktop client for Claude Code'
        : 'Claude Code Haha — Claude Code 的本地优先桌面客户端'
    })
  }, [c, locale])

  return (
    <>
      <a className="u-skip" href="#main">{locale === 'en' ? 'Skip to content' : '跳到正文'}</a>
      <SiteHeader locale={locale} />
      {/* 跳过链接要落在正文开头（含 h1 和主按钮），tabIndex 保证焦点真的搬过来 */}
      <main id="main" tabIndex={-1}>
        <Hero c={c} locale={locale} />
        <Capabilities c={c} />
        <Tour c={c} locale={locale} />
        <Crew c={c} locale={locale} />
        <Paths c={c} />
        <Install c={c} locale={locale} />
      </main>
      <Footer c={c} locale={locale} />
    </>
  )
}
