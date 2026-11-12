import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUpRight, ArrowDown, X, Check, Copy, Plus, Minus, Pause, Play, Code2, MousePointer2, Download, Menu, FolderOpen, SlidersHorizontal, ScanEye, Monitor, Laptop, Command, UsersRound, Layers, PanelsTopLeft, Store, ShieldCheck, MessageCircleQuestion, Send, Smartphone, Wifi } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DOWNLOAD_URL, GITHUB_URL } from '@/components/SiteHeader'
import Icon from '@/components/icons'
import ImageViewer from '@/components/ImageViewer'
import { toSiteHref } from '@/content/docs'
import { setPageMeta } from '@/lib/meta'
import { currentDesktopPlatform } from '@/lib/platform'
import { landingContent, MOBILE_LINKS } from './landingContent'
import type { FeatureId, TaskCategory } from './landingContent'
import AmbientScene from './AmbientScene'
import poster from './assets/wandor-poster.webp'
import landscape from './assets/quiet-landscape.webp'
import stillLife from './assets/quiet-moments.webp'
import filmPoster from './assets/film-poster.webp'
import heroDesktop from './assets/real/hero-desktop.webp'
import phoneHome from './assets/real/phone-home.webp'
import phoneApproval from './assets/real/phone-approval.webp'
import phoneReply from './assets/real/phone-reply.webp'
import teamsShot from './assets/real/agent-teams.webp'
import computerUseShot from './assets/real/computer-use.webp'
import modelsShot from './assets/real/models.webp'
import workbenchShot from './assets/real/workbench.webp'
import skillsShot from './assets/real/skills.webp'
import './home.css'

const VIDEO = 'https://pollen-batch-41236914.figma.site/_components/v2/f0ee2dae7671c170c34f12e31c4cb41418976c98/769c564298c132f7919405cd9f17c1b1231f341d.769c5642.mp4'
// The film is hosted on the CDN; versioned keys keep cached copies from going stale.
const FILM = 'https://cdn.zizhi1.com/cc-haha/site/cchaha-film-1080p-v2.mp4'
const featureIcons: Record<FeatureId, LucideIcon> = { teams: UsersRound, 'computer-use': MousePointer2, models: Layers, workbench: PanelsTopLeft, skills: Store }
// Real captures from the desktop app and the Android app.
const featureImages: Record<FeatureId, string> = { teams: teamsShot, 'computer-use': computerUseShot, models: modelsShot, workbench: workbenchShot, skills: skillsShot }
const phoneScreens = [phoneHome, phoneApproval, phoneReply]
const DESKTOP_SHOT_SIZE = { width: 2000, height: 1300 }
const FEATURE_IMAGE_SIZE = { width: 2000, height: 1250 }
const PHONE_SHOT_SIZE = { width: 900, height: 2000 }
const abilityIcons = [ShieldCheck, MessageCircleQuestion, Send]
const stepIcons = [Download, SlidersHorizontal, FolderOpen, ScanEye]
const taskSteps: Record<TaskCategory, string[]> = {
  code: ['Read the project and understand its constraints', 'Build in steps with a visible record of changes', 'Run checks and review the result together'],
  apps: ['Confirm the app, scope, and permissions', 'Work across desktop apps with Computer Use', 'Review screenshots and the outcome'],
  review: ['Read the changes and map the affected files', 'Check behavior and flag specific lines', 'Review suggestions and choose what comes next']
}

type Preview = { text: string; category: TaskCategory }
type EnlargedImage = { src: string; alt: string; opener: HTMLElement }

function TaskPreview({ task, onClose }: { task: Preview; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const dialog = ref.current!
    const opener = document.activeElement as HTMLElement
    const overflow = document.body.style.overflow
    dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      dialog.close()
      document.body.style.overflow = overflow
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  async function copy() {
    try {
      await navigator.clipboard.writeText(task.text)
      setCopied(true)
      setError('')
    } catch {
      setError('Select the task text below to copy it.')
    }
  }
  return <dialog ref={ref} className="wander-dialog" aria-labelledby="task-preview-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="wander-dialog__head"><span className="wander-eyebrow">cc-haha / YOUR NEXT TASK</span><button className="wander-icon" onClick={onClose} aria-label="Close preview"><X size={20} /></button></div>
    <h2 id="task-preview-title">A little plan. A real beginning.</h2>
    <p className="wander-dialog__note">This is a workflow preview. Run your task in the desktop app with your own model.</p>
    <blockquote>{task.text}</blockquote>
    <ol>{taskSteps[task.category].map((step, index) => <li key={step}><span>0{index + 1}</span>{step}</li>)}</ol>
    <div className="wander-dialog__actions"><button className="wander-secondary" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied' : 'Copy task'}</button><a className="wander-primary" href={DOWNLOAD_URL}>Get the desktop app<ArrowUpRight size={18} /></a></div>
    <p role="status" className="wander-feedback">{error || (copied ? 'Task copied to clipboard.' : '')}</p>
  </dialog>
}

function Nav() {
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && open) { setOpen(false); toggleRef.current?.focus() }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  return <header className="wander-header">
    <a className="wander-wordmark" href={toSiteHref('/')} aria-label="cc-haha">cc-haha</a>
    <nav aria-label="Main navigation" id="wander-nav" className="wander-nav" data-open={open}>
      <a href="#mobile" onClick={() => setOpen(false)}>Phone app</a>
      <a href="#discover" onClick={() => setOpen(false)}>Discover</a>
      <a href="#how-it-works" onClick={() => setOpen(false)}>How it works</a>
      <a href="#faqs" onClick={() => setOpen(false)}>FAQs</a>
      <a className="wander-nav__mobile-docs" href={toSiteHref('/start')}>Documentation</a>
    </nav>
    <div className="wander-header__actions"><a className="wander-doc-link" href={toSiteHref('/start')}>Docs<ArrowUpRight size={15} /></a><a className="wander-github-link" href={GITHUB_URL} target="_blank" rel="noreferrer"><Icon name="github" size={17} />GitHub</a><button ref={toggleRef} className="wander-icon wander-menu" aria-label="Toggle navigation" aria-expanded={open} aria-controls="wander-nav" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button></div>
  </header>
}

function Hero({ paused, setPaused }: { paused: boolean; setPaused: (value: boolean) => void }) {
  const c = landingContent
  const [platform] = useState(currentDesktopPlatform)
  const download = platform ? `Download for ${platform}` : c.downloads.desktop
  return <section className="wander-hero relative w-full overflow-hidden" aria-labelledby="wander-title">
    <AmbientScene src={VIDEO} poster={poster} paused={paused} className="wander-hero__scene" />
    <div className="wander-hero__wash" />
    <div className="relative z-[2] max-w-[1360px] mx-auto"><Nav />
      <div className="wander-hero__body flex flex-col items-center px-6 text-center">
        <span className="wander-eyebrow wander-hero__eyebrow"><i />{c.hero.eyebrow}</span>
        <h1 id="wander-title">{c.hero.headline[0]}<br />{c.hero.headline[1]}<em>{c.hero.accent}</em></h1>
        <p className="wander-hero__description">{c.hero.description.map(sentence => <span key={sentence}>{sentence}</span>)}</p>
        <div className="wander-hero__actions"><a className="wander-primary" href={DOWNLOAD_URL}><Download size={17} />{download}</a><a className="wander-secondary" href={GITHUB_URL} target="_blank" rel="noreferrer"><Icon name="github" size={17} />GitHub</a></div>
        <p className="wander-hero__phone">{c.hero.phoneLabel}<a href={MOBILE_LINKS.android} aria-label={c.downloads.androidLabel}>Android APK</a><span aria-hidden="true">·</span><a href={MOBILE_LINKS.testFlight} aria-label={c.downloads.iphoneLabel}>iPhone TestFlight</a></p>
      </div>
      <figure className="wander-hero__visual"><img className="wander-hero__desktop" src={heroDesktop} alt={c.hero.desktopAlt} width={DESKTOP_SHOT_SIZE.width} height={DESKTOP_SHOT_SIZE.height} fetchPriority="high" /><img className="wander-hero__phone-shot" src={phoneApproval} alt={c.hero.phoneAlt} width={PHONE_SHOT_SIZE.width} height={PHONE_SHOT_SIZE.height} /></figure>
    </div>
    <div className="wander-hero__foot"><a href="#mobile"><ArrowDown size={16} />SCROLL TO EXPLORE</a><button onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? 'Play scenery' : 'Pause scenery'}</button></div>
  </section>
}

function Mobile({ onEnlarge }: { onEnlarge: (image: EnlargedImage) => void }) {
  const c = landingContent
  return <section className="wander-mobile wander-section" id="mobile" aria-labelledby="mobile-title">
    <div className="wander-mobile__copy">
      <span className="wander-eyebrow">01 / THE PHONE APP</span>
      <h2 id="mobile-title">Step away.<br />Keep <em>going.</em></h2>
      <p className="wander-mobile__lede">{c.mobile.description}</p>
      <ul className="wander-mobile__abilities">{c.mobile.abilities.map((item, index) => { const Symbol = abilityIcons[index]; return <li key={item.title}><span className="wander-mobile__icon"><Symbol size={18} strokeWidth={1.6} /></span><strong>{item.title}</strong><span>{item.body}</span></li> })}</ul>
      <p className="wander-mobile__connect"><Wifi size={15} />{c.mobile.connection}</p>
      <div className="wander-mobile__actions"><a className="wander-primary" href={MOBILE_LINKS.android} aria-label={c.downloads.androidLabel}><Download size={16} />{c.downloads.android}</a><a className="wander-secondary" href={MOBILE_LINKS.testFlight} aria-label={c.downloads.iphoneLabel}><Smartphone size={16} />{c.downloads.iphone}</a></div>
      <p className="wander-mobile__note">{c.downloads.requirement}</p>
      <a className="wander-text-link" href={toSiteHref(c.mobile.route)}>{c.mobile.docs}<ArrowUpRight size={16} /></a>
    </div>
    <div className="wander-mobile__screens">{c.mobile.screens.map((screen, index) => <figure key={screen.caption}><button onClick={event => onEnlarge({ src: phoneScreens[index], alt: screen.alt, opener: event.currentTarget })} aria-label={`Enlarge: ${screen.caption}`}><img src={phoneScreens[index]} alt={screen.alt} width={PHONE_SHOT_SIZE.width} height={PHONE_SHOT_SIZE.height} loading="lazy" /></button><figcaption>{screen.caption}</figcaption></figure>)}</div>
  </section>
}

function Discover({ onEnlarge }: { onEnlarge: (image: EnlargedImage) => void }) {
  const c = landingContent
  const [active, setActive] = useState(0)
  const count = c.features.length
  const item = c.features[active]
  const image = featureImages[item.id]
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const choices: Record<string, number> = { ArrowRight: (index + 1) % count, ArrowLeft: (index + count - 1) % count, Home: 0, End: count - 1 }
    if (!(event.key in choices)) return
    event.preventDefault()
    setActive(choices[event.key])
    ;(event.currentTarget.parentElement!.children[choices[event.key]] as HTMLButtonElement).focus()
  }
  return <section className="wander-discover wander-section" id="discover" aria-labelledby="discover-title">
    <div className="wander-section__heading"><span className="wander-eyebrow">02 / MEET YOUR NEW COMPANION</span><h2 id="discover-title">A little less doing.<br />A lot more <em>living.</em></h2><p>One place for your ideas, your apps, and every change along the way.</p></div>
    <div className="wander-feature-tabs" role="tablist" aria-label="Explore capabilities">{c.features.map((feature, index) => { const Symbol = featureIcons[feature.id]; return <button role="tab" key={feature.id} id={`feature-${feature.id}`} aria-controls="feature-panel" aria-selected={active === index} tabIndex={active === index ? 0 : -1} onClick={() => setActive(index)} onKeyDown={event => onKey(event, index)}><Symbol size={17} />{feature.tab}</button> })}</div>
    <div className="wander-showcase" role="tabpanel" id="feature-panel" aria-labelledby={`feature-${item.id}`}>
      <button className="wander-showcase__image" onClick={event => onEnlarge({ src: image, alt: item.alt, opener: event.currentTarget })} aria-label="Enlarge this image"><img key={image} src={image} alt={item.alt} width={FEATURE_IMAGE_SIZE.width} height={FEATURE_IMAGE_SIZE.height} loading="lazy" /><span><Plus size={16} />A closer look</span></button>
      <div className="wander-showcase__caption"><h3>{item.title}</h3><div><p>{item.body}</p><a className="wander-text-link" href={toSiteHref(item.route)}>Read the guide<ArrowUpRight size={16} /></a></div></div>
    </div>
    <div className="wander-discover__note"><span><Check size={14} />Bring your own model</span><span><Check size={14} />Work in your local project</span><span><Check size={14} />Keep the final call</span></div>
  </section>
}

function Film() {
  // The video element is only created after a click, so visitors who never play it download nothing.
  const [started, setStarted] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => { if (started) videoRef.current?.focus() }, [started])
  const posterAlt = 'Frame from the cc-haha film: an Agent Team with every task finished'
  return <section className="wander-film wander-section" id="film" aria-labelledby="film-title">
    <div className="wander-film__teaser" data-playing={started}>
      <div className="wander-film__media">
        {started
          ? <video ref={videoRef} src={FILM} poster={filmPoster} controls autoPlay playsInline preload="metadata" aria-label="cc-haha film" />
          : <button className="wander-film__start" onClick={() => setStarted(true)} aria-label="Play the 62-second film"><img src={filmPoster} alt={posterAlt} width={1600} height={900} loading="lazy" /><span className="wander-film__play"><Play size={18} /></span></button>}
      </div>
      <div className="wander-film__copy">
        <span className="wander-eyebrow">cc-haha / THE FILM · 1:02</span>
        <h2 id="film-title">Want to see it move?</h2>
        <p>A team splits the work, you mark up the page, it works on its own cursor, and every session keeps moving.</p>
        <p className="wander-film__note">No narration; music and sound effects only. Demo data; on-screen times are staged.</p>
      </div>
    </div>
  </section>
}

function Journey() {
  const c = landingContent
  const [active, setActive] = useState(0)
  const step = c.workflowSteps[active]
  const Symbol = stepIcons[active]
  const descriptions = ['Choose macOS, Windows, or Linux. Your next workspace starts right here.', 'An official account, your preferred API, or a local model. Make it your own.', 'A project folder, a clear goal, and the permissions you choose. Ready when you are.', 'Open the diff. Look at the preview. Leave a note. Good work gets better together.']
  return <section className="wander-journey" id="how-it-works" aria-labelledby="journey-title">
    <img className="wander-landscape" src={landscape} alt="" loading="lazy" />
    <div className="wander-journey__inner"><div className="wander-section__heading"><span className="wander-eyebrow">03 / THE FIRST SMALL STEP</span><h2 id="journey-title">New companion.<br />Familiar rhythm.</h2><p>Four small steps. Then, back to the things you love.</p></div>
      <div className="wander-route"><div className="wander-route__steps" aria-label="Getting started steps">{c.workflowSteps.map((item, index) => <button key={item.route} aria-pressed={index === active} onClick={() => setActive(index)}><span>0{index + 1}</span><strong>{item.title}</strong><ArrowUpRight size={17} /></button>)}</div><div className="wander-route__detail" aria-live="polite"><div className="wander-route__stamp"><Symbol size={34} strokeWidth={1.2} /></div><span className="wander-eyebrow">STEP 0{active + 1} / 04</span><h3>{step.title}</h3><p>{descriptions[active]}</p><a className="wander-primary" href={toSiteHref(step.route)}>Show me how<ArrowUpRight size={17} /></a></div></div>
    </div>
    <div className="wander-journey__caption"><span>LESS FRICTION. MORE FREEDOM.</span><span>cc-haha field notes / 02</span></div>
  </section>
}

function Possibilities({ onPreview }: { onPreview: (task: Preview) => void }) {
  const c = landingContent
  return <section className="wander-possibilities wander-section" aria-labelledby="possibilities-title"><div className="wander-possibilities__intro"><span className="wander-eyebrow">04 / MAKE IT YOURS</span><h2 id="possibilities-title">A fresh page.<br />A lighter day.</h2><a className="wander-text-link" href={toSiteHref('/cases')}>Browse the field notes<ArrowUpRight size={18} /></a><img className="wander-stilllife" src={stillLife} alt="" width={900} height={600} loading="lazy" /></div><div className="wander-idea-list">{c.taskSuggestions.map((task, index) => <button className="wander-idea" key={task.category} onClick={() => onPreview({ text: task.prompt, category: task.category })}><span className="wander-idea__number">0{index + 1}</span><span><small>{['SOMETHING TO BUILD', 'SOMETHING TO DELEGATE', 'SOMETHING TO IMPROVE'][index]}</small><strong>{task.label}</strong><span>{task.prompt}</span></span><span className="wander-idea__arrow"><ArrowUpRight size={22} /></span></button>)}</div></section>
}

function Faq() {
  const [active, setActive] = useState<number | null>(0)
  return <section className="wander-faq wander-section" id="faqs" aria-labelledby="faqs-title"><div className="wander-faq__intro"><span className="wander-eyebrow">05 / A FEW THINGS TO KNOW</span><h2 id="faqs-title">Good questions.<br />Honest answers.</h2><p>A little clarity before your first task.</p><a className="wander-text-link" href={toSiteHref('/start')}>More in the docs<ArrowUpRight size={17} /></a></div><div className="wander-faq__list">{landingContent.faqs.map((item, index) => <div className="wander-faq__item" data-open={active === index} key={item.question}><h3><button onClick={() => setActive(active === index ? null : index)} aria-expanded={active === index} aria-controls={`faq-answer-${index}`} id={`faq-question-${index}`}>{item.question}{active === index ? <Minus size={19} /> : <Plus size={19} />}</button></h3><div id={`faq-answer-${index}`} aria-labelledby={`faq-question-${index}`} role="region" hidden={active !== index}><p>{item.answer}</p></div></div>)}</div></section>
}

function Closing() {
  const c = landingContent
  const [platform, setPlatform] = useState(() => currentDesktopPlatform() || 'macOS')
  return <footer className="wander-closing" id="download"><img className="wander-landscape" src={landscape} alt="" loading="lazy" /><div className="wander-closing__content"><span className="wander-eyebrow">YOUR TIME. YOUR POSSIBILITIES.</span><h2>Your next idea<br />starts <em>here.</em></h2><p>{c.closing.body}</p><div className="wander-closing__groups">
      <div className="wander-closing__group" role="group" aria-labelledby="closing-desktop"><span className="wander-closing__label" id="closing-desktop"><Laptop size={14} />Desktop app</span><div className="wander-platforms" aria-label="Choose your operating system">{['macOS', 'Windows', 'Linux'].map((name, index) => { const Symbol = [Command, Monitor, Laptop][index]; return <button key={name} aria-pressed={platform === name} onClick={() => setPlatform(name)}><Symbol size={15} />{name}</button> })}</div><a className="wander-primary wander-download" href={DOWNLOAD_URL}><Download size={18} />Get cc-haha for {platform}<ArrowUpRight size={18} /></a><span className="wander-closing__hint">Choose your architecture on GitHub Releases · Free & open source</span></div>
      <div className="wander-closing__group" role="group" aria-labelledby="closing-phone"><span className="wander-closing__label" id="closing-phone"><Smartphone size={14} />Phone app</span><a className="wander-secondary wander-download" href={MOBILE_LINKS.android} aria-label={c.downloads.androidLabel}><Download size={18} />{c.downloads.android}<ArrowUpRight size={18} /></a><a className="wander-secondary wander-download" href={MOBILE_LINKS.testFlight} aria-label={c.downloads.iphoneLabel}><Smartphone size={18} />{c.downloads.iphone}<ArrowUpRight size={18} /></a><span className="wander-closing__hint">{c.downloads.requirement}</span></div>
    </div></div><div className="wander-footer"><a className="wander-wordmark" href="#wander-title">cc-haha</a><span>A little more room for life.</span><nav aria-label="Footer navigation"><a href={toSiteHref('/start')}>Docs</a><a href={GITHUB_URL} target="_blank" rel="noreferrer"><Code2 size={14} />GitHub</a><a href={toSiteHref('/start/privacy')}>Privacy</a></nav></div></footer>
}

export default function HomePage() {
  const [paused, setPaused] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [enlargedImage, setEnlargedImage] = useState<EnlargedImage | null>(null)
  useEffect(() => {
    setPageMeta({ canonical: '/', description: landingContent.hero.description.join(' '), title: 'cc-haha — Claude Code on your desktop and in your pocket' })
  }, [])
  return <div className="wander-page font-sans"><a className="u-skip" href="#main">Skip to content</a><main id="main" tabIndex={-1}><Hero paused={paused} setPaused={setPaused} /><Mobile onEnlarge={setEnlargedImage} /><Discover onEnlarge={setEnlargedImage} /><Film /><Journey /><Possibilities onPreview={setPreview} /><Faq /></main><Closing />{preview && <TaskPreview task={preview} onClose={() => setPreview(null)} />}{enlargedImage && <ImageViewer image={enlargedImage} onClose={() => setEnlargedImage(null)} />}</div>
}
