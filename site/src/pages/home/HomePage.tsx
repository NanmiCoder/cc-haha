import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react'
import { ArrowUpRight, ArrowRight, ArrowDown, Upload, X, Check, Copy, Plus, Minus, Pause, Play, Code2, MousePointer2, GitCompareArrows, Download, Menu, FileText, FolderOpen, SlidersHorizontal, ScanEye, Monitor, Laptop, Command } from 'lucide-react'
import { DOWNLOAD_URL, GITHUB_URL } from '@/components/SiteHeader'
import ImageViewer from '@/components/ImageViewer'
import { toSiteHref } from '@/content/docs'
import { rememberLocale } from '@/lib/locale'
import { setPageMeta } from '@/lib/meta'
import { guideScreenshots } from './guideContent'
import { landingContent } from './landingContent'
import type { LandingLocale, TaskCategory } from './landingContent'
import AmbientScene from './AmbientScene'
import poster from './assets/wandor-poster.webp'
import landscape from './assets/quiet-landscape.webp'
import stillLife from './assets/quiet-moments.webp'
import projectSession from './assets/project-session.png'
import './home.css'

const VIDEO = 'https://pollen-batch-41236914.figma.site/_components/v2/f0ee2dae7671c170c34f12e31c4cb41418976c98/769c564298c132f7919405cd9f17c1b1231f341d.769c5642.mp4'
const featureIcons = [Code2, MousePointer2, GitCompareArrows]
const stepIcons = [Download, SlidersHorizontal, FolderOpen, ScanEye]
const taskSteps = {
  zh: {
    code: ['先读项目，理解已有风格与约束', '逐步实现，保留清晰的改动记录', '运行检查，再一起审阅结果'],
    apps: ['确认目标应用、操作范围与权限', '通过 Computer Use 完成桌面操作', '查看截图与执行结果'],
    review: ['读取当前改动，整理涉及的文件', '检查逻辑与潜在影响，标注具体位置', '给出建议，由你决定下一步']
  },
  en: {
    code: ['Read the project and understand its constraints', 'Build in steps with a visible record of changes', 'Run checks and review the result together'],
    apps: ['Confirm the app, scope, and permissions', 'Work across desktop apps with Computer Use', 'Review screenshots and the outcome'],
    review: ['Read the changes and map the affected files', 'Check behavior and flag specific lines', 'Review suggestions and choose what comes next']
  }
}

type Attachment = { id: string; name: string; size: number }
type Preview = { text: string; category: TaskCategory; files: Attachment[] }
type EnlargedImage = { src: string; alt: string; opener: HTMLElement }

function TaskPreview({ task, locale, onClose }: { task: Preview; locale: LandingLocale; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const en = locale === 'en'
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
      setError(en ? 'Select the task text below to copy it.' : '请选择下方任务文字手动复制。')
    }
  }
  return <dialog ref={ref} className="wander-dialog" aria-labelledby="task-preview-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="wander-dialog__head"><span className="wander-eyebrow">cc-haha / {en ? 'YOUR NEXT TASK' : '你的下一件事'}</span><button className="wander-icon" onClick={onClose} aria-label={en ? 'Close preview' : '关闭预览'}><X size={20} /></button></div>
    <h2 id="task-preview-title">{en ? 'A little plan. A real beginning.' : '把想法，变成下一步。'}</h2>
    <p className="wander-dialog__note">{en ? 'This is a workflow preview. Run your task in the desktop app with your own model.' : '这里预览工作流程。实际任务将在桌面端连接你的模型后执行。'}</p>
    <blockquote>{task.text}</blockquote>
    {task.files.length > 0 && <p className="wander-dialog__files"><FileText size={16} />{task.files.map(file => file.name).join(' · ')}<small>{en ? 'Selected locally; add these files again in the desktop app.' : '仅在本页选择，请在桌面端重新添加这些文件。'}</small></p>}
    <ol>{taskSteps[locale][task.category].map((step, index) => <li key={step}><span>0{index + 1}</span>{step}</li>)}</ol>
    <div className="wander-dialog__actions"><button className="wander-secondary" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? (en ? 'Copied' : '已复制任务') : (en ? 'Copy task' : '复制任务')}</button><a className="wander-primary" href={DOWNLOAD_URL}>{en ? 'Get the desktop app' : '下载桌面端'}<ArrowUpRight size={18} /></a></div>
    <p role="status" className="wander-feedback">{error || (copied ? (en ? 'Task copied to clipboard.' : '任务已复制到剪贴板。') : '')}</p>
  </dialog>
}

function Nav({ locale }: { locale: LandingLocale }) {
  const [open, setOpen] = useState(false)
  const en = locale === 'en'
  const toggleRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && open) { setOpen(false); toggleRef.current?.focus() }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  return <header className="wander-header">
    <a className="wander-wordmark" href={toSiteHref(en ? '/en' : '/')} aria-label="cc-haha">cc-haha</a>
    <nav aria-label={en ? 'Main navigation' : '主导航'} id="wander-nav" className="wander-nav" data-open={open}>
      <a href="#discover" onClick={() => setOpen(false)}>{en ? 'Discover' : '发现可能'}</a>
      <a href="#how-it-works" onClick={() => setOpen(false)}>{en ? 'How it works' : '如何开始'}</a>
      <a href="#faqs" onClick={() => setOpen(false)}>{en ? 'FAQs' : '常见问题'}</a>
      <a className="wander-nav__mobile-docs" href={toSiteHref(en ? '/en/start' : '/start')}>{en ? 'Documentation' : '使用文档'}</a>
    </nav>
    <div className="wander-header__actions"><a className="wander-doc-link" href={toSiteHref(en ? '/en/start' : '/start')}>{en ? 'Docs' : '使用文档'}<ArrowUpRight size={15} /></a><a className="wander-locale" href={toSiteHref(en ? '/' : '/en')} lang={en ? 'zh-CN' : 'en'} aria-label={en ? 'Switch to Chinese' : '切换为英文'} onClick={() => rememberLocale(en ? 'zh' : 'en')}>{en ? '中文' : 'EN'}</a><a className="wander-primary" href="#download">{en ? 'Get cc-haha' : '免费下载'}<ArrowUpRight size={17} /></a><button ref={toggleRef} className="wander-icon wander-menu" aria-label={en ? 'Toggle navigation' : '切换导航'} aria-expanded={open} aria-controls="wander-nav" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button></div>
  </header>
}

function Hero({ locale, paused, setPaused, onPreview }: { locale: LandingLocale; paused: boolean; setPaused: (value: boolean) => void; onPreview: (task: Preview) => void }) {
  const c = landingContent[locale]
  const en = locale === 'en'
  const [text, setText] = useState(c.hero.promptDefault)
  const [selected, setSelected] = useState<TaskCategory>('code')
  const [files, setFiles] = useState<Attachment[]>([])
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setText(c.hero.promptDefault); setFiles([]); setError(''); setSelected('code') }, [c])
  function attach(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files || [])
    const allowed = selectedFiles.filter(file => (file.type.startsWith('image/') || file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) && file.size <= 10 * 1024 * 1024)
    const combined = [...files, ...allowed.map(file => ({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, size: file.size }))]
    const unique = [...new Map(combined.map(file => [file.id, file])).values()]
    setFiles(unique.slice(0, 3))
    setError(allowed.length !== selectedFiles.length || unique.length > 3 ? (en ? 'Up to 3 images or PDFs, 10 MB each.' : '最多添加 3 个图片或 PDF，每个不超过 10 MB。') : '')
    event.target.value = ''
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) { setError(en ? 'Tell us what you want to do first.' : '先写下你想做的事。'); return }
    setError('')
    onPreview({ text: text.trim(), category: selected, files })
  }
  return <section className="wander-hero relative min-h-svh w-full overflow-hidden" aria-labelledby="wander-title">
    <AmbientScene src={VIDEO} poster={poster} paused={paused} className="wander-hero__scene" />
    <div className="wander-hero__wash" />
    <div className="relative z-[2] max-w-[1360px] mx-auto"><Nav locale={locale} />
      <div className="wander-hero__body flex flex-col items-center px-6 text-center">
        <span className="wander-eyebrow wander-hero__eyebrow"><i />{c.hero.eyebrow}</span>
        <h1 id="wander-title">{c.hero.headline[0]}<br />{c.hero.headline[1]}</h1>
        <p className="wander-hero__description">{c.hero.description}</p>
        <form className="wander-prompt" onSubmit={submit}>
          <label className="u-sr-only" htmlFor="task-prompt">{en ? 'What would you like to do?' : '你想完成什么任务？'}</label>
          <textarea id="task-prompt" value={text} onChange={event => setText(event.target.value)} maxLength={2000} spellCheck={false} />
          {files.length > 0 && <div className="wander-prompt__attachments">{files.map(file => <span key={file.id}><FileText size={12} /><span>{file.name}</span><button type="button" aria-label={`${en ? 'Remove' : '移除'} ${file.name}`} onClick={() => setFiles(files.filter(item => item.id !== file.id))}><X size={12} /></button></span>)}</div>}
          <div className="wander-prompt__bottom"><div className="wander-prompt__tools"><input ref={fileRef} type="file" accept="image/*,.pdf" multiple hidden onChange={attach} /><button type="button" className="wander-upload" onClick={() => fileRef.current?.click()} aria-label={en ? 'Attach inspiration' : '添加参考图片或 PDF'}><Upload size={18} /></button><span>{en ? 'A little idea goes a long way' : '从一个小想法开始'}</span></div><button className="wander-primary" type="submit" disabled={!text.trim()}>{en ? 'See the workflow' : '看看怎么做'}<ArrowUpRight size={18} /></button></div>
        </form>
        <p className="wander-feedback" role="status">{error}</p>
        <div className="wander-suggestions" aria-label={en ? 'Try an idea' : '试试这些想法'}>{c.taskSuggestions.map((item, index) => { const Symbol = featureIcons[index]; return <button key={item.category} aria-pressed={selected === item.category} onClick={() => { setText(item.prompt); setSelected(item.category) }}><Symbol size={14} />{item.label}</button> })}</div>
      </div>
    </div>
    <div className="wander-hero__foot"><a href="#discover"><ArrowDown size={16} />{en ? 'SCROLL TO EXPLORE' : '往下走，看看更多可能'}</a><span>macOS · Windows · Linux</span><button onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? (en ? 'Play scenery' : '播放风景') : (en ? 'Pause scenery' : '暂停风景')}</button></div>
  </section>
}

function Discover({ locale, onEnlarge }: { locale: LandingLocale; onEnlarge: (image: EnlargedImage) => void }) {
  const c = landingContent[locale]
  const en = locale === 'en'
  const [active, setActive] = useState(0)
  const item = c.features[active]
  const images = { ...guideScreenshots[locale], session: projectSession }
  const screenshot = images[item.imageKey]
  const dimensions = {
    session: { width: 3456, height: 2168 },
    settings: { width: 2000, height: 1651 },
    workspace: { width: 2000, height: 1255 },
  }[item.imageKey]
  const screenshotAlt = item.imageKey === 'session'
    ? (en ? 'cc-haha with the real project and session list visible' : 'cc-haha 真实项目界面，完整展示左侧项目与会话列表')
    : item.title
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const choices: Record<string, number> = { ArrowRight: (index + 1) % 3, ArrowLeft: (index + 2) % 3, Home: 0, End: 2 }
    if (!(event.key in choices)) return
    event.preventDefault()
    setActive(choices[event.key])
    ;(event.currentTarget.parentElement!.children[choices[event.key]] as HTMLButtonElement).focus()
  }
  return <section className="wander-discover wander-section" id="discover" aria-labelledby="discover-title">
    <div className="wander-section__heading"><span className="wander-eyebrow">01 / {en ? 'MEET YOUR NEW COMPANION' : '认识你的新搭档'}</span><h2 id="discover-title">{en ? <>A little less doing.<br />A lot more <em>living.</em></> : <>少一点忙碌。<br />多一点<em>可能。</em></>}</h2><p>{en ? 'One place for your ideas, your apps, and every change along the way.' : '想法、应用和每一次改动，都在同一个工作空间里。'}</p></div>
    <div className="wander-feature-tabs" role="tablist" aria-label={en ? 'Explore capabilities' : '探索产品能力'}>{c.features.map((feature, index) => { const Symbol = featureIcons[index]; return <button role="tab" key={feature.id} id={`feature-${feature.id}`} aria-controls="feature-panel" aria-selected={active === index} tabIndex={active === index ? 0 : -1} onClick={() => setActive(index)} onKeyDown={event => onKey(event, index)}><Symbol size={17} />{en ? ['Write code', 'Use apps', 'Review changes'][index] : ['写代码', '操作应用', '审阅改动'][index]}</button> })}</div>
    <div className="wander-showcase" role="tabpanel" id="feature-panel" aria-labelledby={`feature-${item.id}`}>
      <div className="wander-showcase__bar"><span className="wander-window-dots"><i /><i /><i /></span><span>cc-haha / {en ? 'YOUR WORKSPACE' : '你的工作空间'}</span><span className="wander-live"><i />{en ? 'REAL PRODUCT' : '真实产品界面'}</span></div>
      <button className="wander-showcase__image" onClick={event => onEnlarge({ src: screenshot, alt: screenshotAlt, opener: event.currentTarget })} aria-label={en ? 'Enlarge product screenshot' : '放大查看产品截图'}><img key={item.imageKey} src={screenshot} alt={screenshotAlt} width={dimensions.width} height={dimensions.height} loading="lazy" /><span><Plus size={16} />{en ? 'A closer look' : '看看细节'}</span></button>
      <div className="wander-showcase__caption"><div><span className="wander-eyebrow">{item.kicker}</span><h3>{item.title}</h3></div><div><p>{item.body}</p><a className="wander-text-link" href={toSiteHref(item.route)}>{en ? 'Explore this workflow' : '了解这个工作流'}<ArrowUpRight size={16} /></a></div></div>
    </div>
    <div className="wander-discover__note"><span><Check size={14} />{en ? 'Bring your own model' : '连接你自己的模型'}</span><span><Check size={14} />{en ? 'Work in your local project' : '在本地项目里工作'}</span><span><Check size={14} />{en ? 'Keep the final call' : '下一步，由你决定'}</span></div>
  </section>
}

function Journey({ locale }: { locale: LandingLocale }) {
  const c = landingContent[locale]
  const en = locale === 'en'
  const [active, setActive] = useState(0)
  const step = c.workflowSteps[active]
  const Symbol = stepIcons[active]
  const descriptions = en ? ['Choose macOS, Windows, or Linux. Your next workspace starts right here.', 'An official account, your preferred API, or a local model. Make it your own.', 'A project folder, a clear goal, and the permissions you choose. Ready when you are.', 'Open the diff. Look at the preview. Leave a note. Good work gets better together.'] : ['选择 macOS、Windows 或 Linux 版本，让新搭档住进你的电脑。', '官方账号、熟悉的 API 服务或本地模型。用适合你的方式连接。', '一个项目文件夹、一个明确的目标，再选好权限。随时可以开始。', '打开文件差异，看看页面预览，留下具体反馈。让这一轮比上一轮更好。']
  return <section className="wander-journey" id="how-it-works" aria-labelledby="journey-title">
    <img className="wander-landscape" src={landscape} alt="" loading="lazy" />
    <div className="wander-journey__inner"><div className="wander-section__heading"><span className="wander-eyebrow">02 / {en ? 'THE FIRST SMALL STEP' : '从这里出发'}</span><h2 id="journey-title">{en ? <>New companion.<br />Familiar rhythm.</> : <>新搭档，<br />你的老习惯。</>}</h2><p>{en ? 'Four small steps. Then, back to the things you love.' : '只需要四小步，然后，把时间还给你喜欢的事。'}</p></div>
      <div className="wander-route"><div className="wander-route__steps" aria-label={en ? 'Getting started steps' : '上手步骤'}>{c.workflowSteps.map((item, index) => <button key={item.route} aria-pressed={index === active} onClick={() => setActive(index)}><span>0{index + 1}</span><strong>{item.title}</strong><ArrowUpRight size={17} /></button>)}</div><div className="wander-route__detail" aria-live="polite"><div className="wander-route__stamp"><Symbol size={34} strokeWidth={1.2} /></div><span className="wander-eyebrow">STEP 0{active + 1} / 04</span><h3>{step.title}</h3><p>{descriptions[active]}</p><a className="wander-primary" href={toSiteHref(step.route)}>{en ? 'Show me how' : '带我开始'}<ArrowUpRight size={17} /></a></div></div>
    </div>
    <div className="wander-journey__caption"><span>{en ? 'LESS FRICTION. MORE FREEDOM.' : '少一点阻力，多一点自由。'}</span><span>cc-haha field notes / 02</span></div>
  </section>
}

function Possibilities({ locale, onPreview }: { locale: LandingLocale; onPreview: (task: Preview) => void }) {
  const en = locale === 'en'
  const c = landingContent[locale]
  return <section className="wander-possibilities wander-section" aria-labelledby="possibilities-title"><div className="wander-possibilities__intro"><span className="wander-eyebrow">03 / {en ? 'MAKE IT YOURS' : '换成你想做的事'}</span><h2 id="possibilities-title">{en ? <>A fresh page.<br />A lighter day.</> : <>想法那么多，<br />一个个来。</>}</h2><a className="wander-text-link" href={toSiteHref(en ? '/en/cases' : '/cases')}>{en ? 'Browse the field notes' : '翻翻实战手册'}<ArrowUpRight size={18} /></a><img className="wander-stilllife" src={stillLife} alt="" width={900} height={600} loading="lazy" /></div><div className="wander-idea-list">{c.taskSuggestions.map((task, index) => <button className="wander-idea" key={task.category} onClick={() => onPreview({ text: task.prompt, category: task.category, files: [] })}><span className="wander-idea__number">0{index + 1}</span><span><small>{en ? ['SOMETHING TO BUILD', 'SOMETHING TO DELEGATE', 'SOMETHING TO IMPROVE'][index] : ['给灵感一个形状', '把重复留给搭档', '让结果更好一点'][index]}</small><strong>{task.label}</strong><span>{task.prompt}</span></span><span className="wander-idea__arrow"><ArrowUpRight size={22} /></span></button>)}</div></section>
}

function Faq({ locale }: { locale: LandingLocale }) {
  const en = locale === 'en'
  const [active, setActive] = useState<number | null>(0)
  return <section className="wander-faq wander-section" id="faqs" aria-labelledby="faqs-title"><div className="wander-faq__intro"><span className="wander-eyebrow">04 / {en ? 'A FEW THINGS TO KNOW' : '出发前，聊几句'}</span><h2 id="faqs-title">{en ? <>Good questions.<br />Honest answers.</> : <>你可能<br />还想知道。</>}</h2><p>{en ? 'A little clarity before your first task.' : '把疑问解开，再轻松开始。'}</p><a className="wander-text-link" href={toSiteHref(en ? '/en/start' : '/start')}>{en ? 'More in the docs' : '更多答案在文档里'}<ArrowUpRight size={17} /></a></div><div className="wander-faq__list">{landingContent[locale].faqs.map((item, index) => <div className="wander-faq__item" data-open={active === index} key={item.question}><h3><button onClick={() => setActive(active === index ? null : index)} aria-expanded={active === index} aria-controls={`faq-answer-${index}`} id={`faq-question-${index}`}>{item.question}{active === index ? <Minus size={19} /> : <Plus size={19} />}</button></h3><div id={`faq-answer-${index}`} aria-labelledby={`faq-question-${index}`} role="region" hidden={active !== index}><p>{item.answer}</p></div></div>)}</div></section>
}

function Closing({ locale }: { locale: LandingLocale }) {
  const en = locale === 'en'
  const c = landingContent[locale]
  const [platform, setPlatform] = useState('macOS')
  return <footer className="wander-closing" id="download"><img className="wander-landscape" src={landscape} alt="" loading="lazy" /><div className="wander-closing__content"><span className="wander-eyebrow">{en ? 'YOUR TIME. YOUR POSSIBILITIES.' : '你的时间，你的可能。'}</span><h2>{en ? <>Your next idea<br />starts <em>here.</em></> : <>下一件想做的事，<br /><em>从这里开始。</em></>}</h2><p>{c.closing.body}</p><div className="wander-platforms" aria-label={en ? 'Choose your operating system' : '选择你的操作系统'}>{['macOS', 'Windows', 'Linux'].map((name, index) => { const Symbol = [Command, Monitor, Laptop][index]; return <button key={name} aria-pressed={platform === name} onClick={() => setPlatform(name)}><Symbol size={15} />{name}</button> })}</div><a className="wander-primary wander-download" href={DOWNLOAD_URL}><Download size={18} />{en ? `Get cc-haha for ${platform}` : `下载 ${platform} 版`}<ArrowUpRight size={18} /></a><span className="wander-closing__hint">{en ? 'Choose your architecture on GitHub Releases · Free & open source' : '前往 GitHub Releases 选择对应架构 · 免费开源'}</span></div><div className="wander-footer"><a className="wander-wordmark" href="#wander-title">cc-haha</a><span>{en ? 'A little more room for life.' : '给生活，多留一点空间。'}</span><nav aria-label={en ? 'Footer navigation' : '页脚导航'}><a href={toSiteHref(en ? '/en/start' : '/start')}>{en ? 'Docs' : '文档'}</a><a href={GITHUB_URL} target="_blank" rel="noreferrer"><Code2 size={14} />GitHub</a><a href={toSiteHref(en ? '/en/start/privacy' : '/start/privacy')}>{en ? 'Privacy' : '隐私'}</a><a href={toSiteHref(en ? '/' : '/en')} onClick={() => rememberLocale(en ? 'zh' : 'en')}>{en ? '中文' : 'English'}</a></nav></div></footer>
}

export default function HomePage({ locale = 'en' }: { locale?: LandingLocale }) {
  const [paused, setPaused] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [enlargedImage, setEnlargedImage] = useState<EnlargedImage | null>(null)
  useEffect(() => {
    setPageMeta({ alternate: locale === 'en' ? '/' : '/en', canonical: locale === 'en' ? '/en' : '/', description: landingContent[locale].hero.description, lang: locale === 'en' ? 'en' : 'zh-CN', title: locale === 'en' ? 'cc-haha — Less busywork. More room for life.' : 'cc-haha — 把琐碎交给 AI，把时间留给生活。' })
  }, [locale])
  return <div className="wander-page font-sans"><a className="u-skip" href="#main">{locale === 'en' ? 'Skip to content' : '跳到正文'}</a><main id="main" tabIndex={-1}><Hero locale={locale} paused={paused} setPaused={setPaused} onPreview={setPreview} /><Discover locale={locale} onEnlarge={setEnlargedImage} /><Journey locale={locale} /><Possibilities locale={locale} onPreview={setPreview} /><Faq locale={locale} /></main><Closing locale={locale} />{preview && <TaskPreview task={preview} locale={locale} onClose={() => setPreview(null)} />}{enlargedImage && <ImageViewer image={enlargedImage} locale={locale} onClose={() => setEnlargedImage(null)} />}</div>
}
