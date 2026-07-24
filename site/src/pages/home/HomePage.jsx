import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/Icon'
import appIcon from '../../../../docs/images/app-icon.png'
import mainSession from '../../../../docs/images/desktop_ui/25_main_session.png'
import petSettings from '../../../../docs/images/desktop_ui/14_pet_settings_overview.png'
import computerUse from '../../../../docs/images/desktop_ui/06_settings_computer_use.png'
import scheduledTask from '../../../../docs/images/desktop_ui/20_scheduled_task.png'
import skillMarketplace from '../../../../docs/images/desktop_ui/21_skill_marketplace.png'
import diffReview from '../../../../docs/images/desktop_ui/23_workspace_diff_review.png'
import browserPreview from '../../../../docs/images/desktop_ui/24_browser_preview.png'
import dada from '../../../../desktop/src/assets/agent-mascots/agent-mascot-code.png'
import huhu from '../../../../desktop/src/assets/agent-mascots/agent-mascot-plan.png'
import bubu from '../../../../desktop/src/assets/agent-mascots/agent-mascot-fix.png'
import huihui from '../../../../desktop/src/assets/agent-mascots/agent-mascot-build.png'

const DOWNLOAD_URL = 'https://github.com/NanmiCoder/cc-haha/releases/latest'
const GITHUB_URL = 'https://github.com/NanmiCoder/cc-haha'

const content = {
  zh: {
    nav: ['产品旅程', '真实界面', '认识搭档', '文档'],
    download: '下载桌面端',
    eyebrow: 'CLAUDE CODE · 现在有了一间工作室',
    titleA: 'Agent 干活的全过程，',
    titleB: '你看得见、审得完、管得住。',
    intro: 'Claude Code 的本地优先桌面工作室：跑会话、派 Agent、审改动，离开电脑用手机继续同一条会话。',
    primary: '下载 macOS / Windows / Linux',
    secondary: '先跑通第一条会话',
    local: '本地优先',
    providers: '模型自选',
    remote: '离开也能续',
    fig: 'FIG. 01 — MAIN SESSION · 实拍直出',
    figStatus: '127.0.0.1 · 已连接',
    heroNote: '真实截图，没修过——连光标都是原装的。',
    rail: '桌面工作室 · A STUDIO FOR CLAUDE CODE · 本地优先 ·',
    journeyEyebrow: 'ONE SESSION, MANY HANDS',
    journeyTitle: '一句话开工，五步见结果。',
    journeyIntro: '所有功能挂在同一条会话上：你说目标，它们各司其职，进度随时可查。',
    steps: [
      ['01', '说出任务', '在 Main Session 里输入目标，选好项目、模型和权限模式，回车开工。'],
      ['02', '拆开派活', '大活交给 Task、SubAgent 或 Agent Team 并行干，后台 Agent 的工具活动也汇总进活动面板。'],
      ['03', '审完再落地', '改动按文件逐个看 Diff，试验放进 Worktree 不碰主分支，你点头才落地。'],
      ['04', '把手伸出电脑', 'Computer Use 让 Agent 操作真实桌面；出门用手机 H5 或 IM 继续会话，断连不中断。'],
      ['05', '到点自动跑', '把重复流程设成定时任务，到点在独立会话执行，每跑一次都留记录可复盘。'],
    ],
    tourEyebrow: 'REAL PRODUCT, NOT A MOCKUP',
    tourTitle: '所有截图，都拍自真实产品。',
    tourIntro: '不用概念图充数：全部截取自运行中的桌面端，你看到的功能，装好就是那个样子。',
    tours: [
      { id: 'session', label: 'Main Session', kicker: '从对话到代码', title: '描述目标，看它一步步做完。', body: '选好项目、模型和权限后开聊；它产生的每处代码改动都留在上下文里，等你审完再落地。', image: mainSession },
      { id: 'pets', label: '桌面宠物', kicker: '状态一眼可见', title: '宠物在动，Agent 就在干活。', body: '搭搭、弧弧、补补、回回随任务状态变换动作；上传一张角色图，就能养一只自己的。', image: petSettings },
      { id: 'computer', label: 'Computer Use', kicker: '看得见，也动得了', title: '能看屏幕，能点能输能验证。', body: '原生无障碍引擎驱动：Agent 能看屏幕、点鼠标、敲键盘，做完还会自己核对；授权分级，敏感操作等你点头。', image: computerUse },
      { id: 'schedule', label: '定时任务', kicker: '到点自动开工', title: '设好时间，它按时回来交活。', body: '定好频率、模型、目录和通知方式；任务在独立会话执行，每跑一次都有记录可查。', image: scheduledTask },
      { id: 'skills', label: 'Skills & Agents', kicker: '给 Agent 添本事', title: '缺什么手艺，装什么手艺。', body: '看中就装，来源和安全提示摆在明处；再给自己的 Agent 单独配模型、工具和系统提示词。', image: skillMarketplace },
      { id: 'diff', label: '代码审阅', kicker: '先看清楚再决定', title: '改了什么，逐个文件看清楚。', body: '改动按文件列出，Diff 逐行对照；Worktree 把试验隔在主分支外，合不合你说了算。', image: diffReview },
      { id: 'preview', label: '浏览器预览', kicker: '做完当场验证', title: '页面效果，会话里直接验证。', body: '在应用里打开本地或公开网页，看到问题直接带回会话继续改；出门就换 H5 或 IM 接力。', image: browserPreview },
    ],
    petEyebrow: 'MEET THE CREW',
    petTitle: '认识搭搭、弧弧、补补、回回。',
    petIntro: '一个图标代表所有状态，太敷衍了。搭搭、弧弧、补补、回回随任务变换动作——忙不忙，看一眼就知道。',
    pets: [
      ['搭搭', 'Dada', '搭建', '把想法一块块变成可运行的东西。', dada, '#2eaa91'],
      ['弧弧', 'Huhu', '规划', '复杂任务也能画出一条清楚路线。', huhu, '#3577d4'],
      ['补补', 'Bubu', '修复', '找到裂缝，验证之后再补好它。', bubu, '#e56645'],
      ['回回', 'Huihui', '构建', '新回复一到，就抱着齿轮继续跑。', huihui, '#7657c8'],
    ],
    docsEyebrow: 'THE FIELD GUIDE',
    docsTitle: '按任务查，不按目录翻。',
    docsIntro: '文档按真实任务组织：先跑通第一次会话，再按需深入配置、原理和排障。',
    docGroups: [
      ['第一次上手', '装好应用、接上模型账号，跑通你的第一条 Main Session。', '/desktop/01-quick-start', '打开快速上手'],
      ['用熟桌面端', '会话、多 Agent 协作、代码审阅、宠物和定时任务，一个个用起来。', '/desktop/03-features', '逛逛桌面功能'],
      ['连到电脑外', '配置 Computer Use、手机 H5 和 IM 接入，弄清授权和安全边界。', '/features/computer-use', '配置远程入口'],
      ['看懂底层', '本地服务、Agent 机制、记忆、Skills 和项目结构，写给想改代码的人。', '/reference/project-structure', '读开发者参考'],
    ],
    installEyebrow: 'READY WHEN YOU ARE',
    installTitle: '现在下载，马上开工。',
    installBody: 'GitHub Releases 有三平台安装包，也可 bun install 从源码跑。打开、选项目、说任务，今天就跑通第一条会话。',
    copy: '复制',
    copied: '已复制',
    footer: '本地优先的 Claude Code 桌面工作室',
  },
  en: {
    nav: ['Journey', 'Real UI', 'Meet the crew', 'Docs'],
    download: 'Download desktop',
    eyebrow: 'CLAUDE CODE · NOW HAS A STUDIO',
    titleA: 'Every step your agents take,',
    titleB: 'you can see, review, and stop.',
    intro: 'A local-first studio for Claude Code: run sessions, split work across agents, review diffs, and keep going from your phone.',
    primary: 'Download for macOS / Windows / Linux',
    secondary: 'Run your first session',
    local: 'Local-first',
    providers: 'Bring your models',
    remote: 'Phone-friendly',
    fig: 'FIG. 01 — MAIN SESSION, AS SHIPPED',
    figStatus: '127.0.0.1 · CONNECTED',
    heroNote: 'A real screenshot, unretouched—cursor included as found.',
    rail: 'A STUDIO FOR CLAUDE CODE · LOCAL-FIRST · DESKTOP-NATIVE ·',
    journeyEyebrow: 'ONE SESSION, MANY HANDS',
    journeyTitle: 'One sentence starts it. Five steps finish it.',
    journeyIntro: 'Every capability hangs off the same session, so you never switch tools to get from ask to done.',
    steps: [
      ['01', 'Say the task', 'Type the goal into Main Session, pick the project, model, and permission mode, and hit enter.'],
      ['02', 'Split the work', 'Break big jobs across tasks, subagents, or an agent team. Background progress still rolls up into the activity panel.'],
      ['03', 'Review, then land', 'Open a diff for every changed file, keep experiments in a worktree, and land nothing until you approve it.'],
      ['04', 'Reach past the screen', 'Computer Use operates the real desktop. Away from it, continue the same session from H5 or IM—disconnects don\'t interrupt.'],
      ['05', 'Put it on a clock', 'Turn repeatable routines into scheduled jobs that run in their own sessions, each run leaving a record to revisit.'],
    ],
    tourEyebrow: 'REAL PRODUCT, NOT A MOCKUP',
    tourTitle: 'Every screenshot is the real app.',
    tourIntro: 'No concept art. The feature you see in a frame is the one that opens after install.',
    tours: [
      { id: 'session', label: 'Main Session', kicker: 'From prompt to code', title: 'Describe the goal. Watch it get done.', body: 'Pick the project, model, and permissions, then start talking. Every change it makes stays open for your review.', image: mainSession },
      { id: 'pets', label: 'Desktop pets', kicker: 'Status at a glance', title: 'If a pet is moving, an agent is working.', body: 'Dada, Huhu, Bubu, and Huihui move with the task at hand. Upload one character image and raise a pet of your own.', image: petSettings },
      { id: 'computer', label: 'Computer Use', kicker: 'Eyes and hands on the desktop', title: 'Sees the screen. Clicks, types, verifies.', body: 'Computer Use runs on a native accessibility engine with tiered authorization. Sensitive moves still wait for your nod.', image: computerUse },
      { id: 'schedule', label: 'Scheduled work', kicker: 'Back on time', title: 'Set the time. It comes back with results.', body: 'Pick a cadence, model, directory, and notification. Jobs run in their own sessions, and every run leaves a record you can review.', image: scheduledTask },
      { id: 'skills', label: 'Skills & Agents', kicker: 'A studio that can grow', title: 'Missing a trick? Install it.', body: 'Install what looks useful—source and safety notes are shown up front. Then give each agent its own model, tools, and system prompt.', image: skillMarketplace },
      { id: 'diff', label: 'Code review', kicker: 'Look before you land', title: 'Know exactly what changed, file by file.', body: 'Every edit is listed per file with its diff; worktrees keep experiments off your main branch. What lands is your call.', image: diffReview },
      { id: 'preview', label: 'Browser preview', kicker: 'Verify on the spot', title: 'Check the page without leaving the session.', body: 'Open local or public pages inside the app and bring what you see back into the task. Step away and hand off to H5 or IM instead.', image: browserPreview },
    ],
    petEyebrow: 'MEET THE CREW',
    petTitle: 'Meet Dada, Huhu, Bubu, and Huihui.',
    petIntro: 'One icon for every state felt lazy, so we adopted Dada, Huhu, Bubu, and Huihui—running, thinking, waiting, done. One glance tells you.',
    pets: [
      ['搭搭', 'Dada', 'Build', 'Turns an idea into something you can run.', dada, '#2eaa91'],
      ['弧弧', 'Huhu', 'Plan', 'Finds a clear route through complicated work.', huhu, '#3577d4'],
      ['补补', 'Bubu', 'Fix', 'Finds the crack, proves it, then patches it.', bubu, '#e56645'],
      ['回回', 'Huihui', 'Ship', 'Grabs the gear and moves when a reply arrives.', huihui, '#7657c8'],
    ],
    docsEyebrow: 'THE FIELD GUIDE',
    docsTitle: 'Find answers by task, not by chapter.',
    docsIntro: 'The docs follow real tasks: get your first session running, then go deeper into configuration, internals, and fixes as needed.',
    docGroups: [
      ['First launch', 'Install the app, connect a model account, and finish your first Main Session.', '/en/desktop/01-quick-start', 'Open the quick start'],
      ['The desktop studio', 'Main Session, the activity panel, code review, pets, and scheduled runs.', '/en/desktop/03-features', 'Tour the desktop app'],
      ['Beyond the machine', 'Set up Computer Use, H5, and IM access, and know exactly where the permission boundaries are.', '/en/features/computer-use', 'Configure remote access'],
      ['Under the hood', 'Local services, agent mechanics, memory, skills, and project structure—written for people who hack on it.', '/en/reference/project-structure', 'Read the developer reference'],
    ],
    installEyebrow: 'READY WHEN YOU ARE',
    installTitle: 'Download it and get to work.',
    installBody: 'Grab the installer on GitHub Releases, or bun install from source. Open the app, pick a project, and say your first task.',
    copy: 'Copy',
    copied: 'Copied',
    footer: 'A local-first desktop studio for Claude Code',
  },
}

function useReveal() {
  const scope = useRef(null)

  useEffect(() => {
    const root = scope.current
    if (!root) return

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.dataset.visible = 'true'
          observer.unobserve(entry.target)
        }
      })
    }, { threshold: 0.14 })

    root.querySelectorAll('[data-reveal]').forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [])

  return scope
}

function Header({ locale, c }) {
  const [open, setOpen] = useState(false)
  const prefix = locale === 'en' ? '/en' : ''
  const ids = ['journey', 'tour', 'crew', 'guide']
  const closeMenu = () => setOpen(false)

  return (
    <header className="site-header">
      <a className="brand" href={prefix || '/'} aria-label="Claude Code Haha">
        <span className="brand-mark"><img src={appIcon} alt="" /></span>
        <span className="brand-word">Claude Code <b>Haha</b></span>
      </a>
      <button className="menu-button" type="button" aria-label="Toggle navigation" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="menu" />
      </button>
      <nav className={open ? 'header-nav is-open' : 'header-nav'} aria-label="Main navigation">
        {c.nav.map((item, index) => <a href={`${prefix || ''}/#${ids[index]}`} key={item} onClick={closeMenu}>{item}</a>)}
        <a href={locale === 'en' ? '/' : '/en/'} onClick={closeMenu}>{locale === 'en' ? '中文' : 'EN'}</a>
        <a className="nav-download" href={DOWNLOAD_URL}>
          <Icon name="download" size={15} />{c.download}
        </a>
      </nav>
    </header>
  )
}

function Hero({ locale, c }) {
  return (
    <section className="hero">
      <div className="hero-copy" data-reveal>
        <div className="eyebrow">{c.eyebrow}</div>
        <h1><span>{c.titleA}</span><em>{c.titleB}</em></h1>
        <p className="hero-intro">{c.intro}</p>
        <div className="hero-actions">
          <a className="button button-primary" href={DOWNLOAD_URL}>{c.primary}<Icon name="arrow" /></a>
          <a className="button button-ghost" href={locale === 'en' ? '/en/desktop/01-quick-start' : '/desktop/01-quick-start'}>{c.secondary}<Icon name="arrow" /></a>
        </div>
        <div className="hero-trust" aria-label="Product qualities">
          {[c.local, c.providers, c.remote].map((item) => <span key={item}>{item}</span>)}
        </div>
      </div>
      <div className="hero-stage" data-reveal>
        <div className="stage-frame">
          <div className="frame-meta" aria-hidden="true">
            <span>{c.fig}</span>
            <span className="frame-status"><i />{c.figStatus}</span>
          </div>
          <div className="window-card">
            <div className="window-bar">
              <span><i /><i /><i /></span>
              <b>CLAUDE CODE HAHA</b>
              <small>SESSION — 001</small>
            </div>
            <img src={mainSession} alt="Claude Code Haha Main Session" />
          </div>
          <img className="stage-mascot" src={huhu} alt="" />
          <p className="stage-caption">{c.heroNote}</p>
        </div>
      </div>
      <div className="hero-rail" aria-hidden="true"><span>{c.rail}</span></div>
    </section>
  )
}

function Journey({ c }) {
  return (
    <section className="section journey" id="journey">
      <div className="section-heading" data-reveal>
        <div className="eyebrow">{c.journeyEyebrow}</div>
        <h2>{c.journeyTitle}</h2>
        <p>{c.journeyIntro}</p>
      </div>
      <ol className="journey-list">
        {c.steps.map(([number, title, body]) => (
          <li data-reveal key={number}>
            <div className="step-number">{number}</div>
            <div className="step-copy"><h3>{title}</h3><p>{body}</p></div>
            <div className="step-arrow" aria-hidden="true"><Icon name="arrow" size={22} /></div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ProductTour({ c }) {
  const [activeId, setActiveId] = useState(c.tours[0].id)
  const active = c.tours.find((tour) => tour.id === activeId) || c.tours[0]

  useEffect(() => setActiveId(c.tours[0].id), [c])

  const selectAdjacentTab = (event, currentIndex) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return

    event.preventDefault()
    let nextIndex = currentIndex
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = c.tours.length - 1
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + c.tours.length) % c.tours.length
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % c.tours.length

    const nextTour = c.tours[nextIndex]
    setActiveId(nextTour.id)
    event.currentTarget.parentElement
      ?.querySelector(`#tour-tab-${nextTour.id}`)
      ?.focus()
  }

  return (
    <section className="section product-tour" id="tour">
      <div className="tour-heading" data-reveal>
        <div>
          <div className="eyebrow">{c.tourEyebrow}</div>
          <h2>{c.tourTitle}</h2>
        </div>
        <p>{c.tourIntro}</p>
      </div>
      <div className="tour-tabs" role="tablist" aria-label="Product tour">
        {c.tours.map((tour, index) => (
          <button
            aria-controls={`tour-panel-${tour.id}`}
            aria-selected={active.id === tour.id}
            className={active.id === tour.id ? 'is-active' : ''}
            id={`tour-tab-${tour.id}`}
            key={tour.id}
            onClick={() => setActiveId(tour.id)}
            onKeyDown={(event) => selectAdjacentTab(event, index)}
            role="tab"
            tabIndex={active.id === tour.id ? 0 : -1}
            type="button"
          >
            <span>{String(index + 1).padStart(2, '0')}</span>{tour.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`tour-tab-${active.id}`}
        className="tour-board"
        data-reveal
        id={`tour-panel-${active.id}`}
        role="tabpanel"
        tabIndex={0}
      >
        <div className="tour-copy">
          <div className="tour-kicker">{active.kicker}</div>
          <h3>{active.title}</h3>
          <p>{active.body}</p>
        </div>
        <div className="tour-screen">
          <img key={active.id} src={active.image} alt={`${active.label} interface`} />
        </div>
      </div>
    </section>
  )
}

function Crew({ c }) {
  return (
    <section className="section crew" id="crew">
      <div className="crew-intro" data-reveal>
        <div className="eyebrow">{c.petEyebrow}</div>
        <h2>{c.petTitle}</h2>
        <p>{c.petIntro}</p>
      </div>
      <div className="crew-track">
        {c.pets.map(([name, latin, role, body, image, color], index) => (
          <article className="crew-member" data-reveal key={latin} style={{ '--pet-accent': color, '--pet-delay': `${index * 90}ms` }}>
            <div className="crew-callsign"><span>UNIT 0{index + 1}</span><i style={{ background: color }} /></div>
            <div className="pet-portrait"><img src={image} alt="" /></div>
            <div className="crew-role">{role}</div>
            <h3>{name}<em>{latin}</em></h3>
            <p>{body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function Guide({ c }) {
  return (
    <section className="section guide" id="guide">
      <div className="guide-title" data-reveal>
        <div className="eyebrow">{c.docsEyebrow}</div>
        <h2>{c.docsTitle}</h2>
        <p>{c.docsIntro}</p>
      </div>
      <div className="guide-stack">
        {c.docGroups.map(([title, body, href, action], index) => (
          <a className="guide-row" data-reveal href={href} key={title}>
            <span className="guide-number">{String(index + 1).padStart(2, '0')}</span>
            <span className="guide-row-copy"><strong>{title}</strong><small>{body}</small></span>
            <span className="guide-action">{action}<Icon name="arrow" /></span>
          </a>
        ))}
      </div>
    </section>
  )
}

function Install({ locale, c }) {
  const [copied, setCopied] = useState(false)
  const command = [
    'git clone https://github.com/NanmiCoder/cc-haha.git',
    'cd cc-haha && bun install',
    './bin/claude-haha',
  ].join('\n')

  const copyCommand = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <section className="section install" id="install">
      <div className="install-copy">
        <div className="eyebrow">{c.installEyebrow}</div>
        <h2>{c.installTitle}</h2>
        <p>{c.installBody}</p>
        <div className="install-actions">
          <a className="button button-paper" href={DOWNLOAD_URL}><Icon name="download" />{c.primary}</a>
          <a className="text-link" href={locale === 'en' ? '/en/desktop/04-installation' : '/desktop/04-installation'}>Installation guide <Icon name="arrow" size={16} /></a>
        </div>
      </div>
      <div className="command-sheet">
        <div className="command-label">CLI · SOURCE CHECKOUT</div>
        <code>
          <span>$</span> git clone https://github.com/NanmiCoder/cc-haha.git<br />
          <span>$</span> cd cc-haha &amp;&amp; bun install<br />
          <span>$</span> ./bin/claude-haha
        </code>
        <button type="button" onClick={copyCommand}><Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? c.copied : c.copy}</button>
        <p>Desktop + CLI · same local runtime</p>
        <div className="install-mascot" aria-hidden="true"><img src={dada} alt="" /></div>
      </div>
    </section>
  )
}

function Footer({ locale, c }) {
  return (
    <footer className="footer">
      <div className="brand footer-brand"><span className="brand-mark"><img src={appIcon} alt="" /></span><span className="brand-word">Claude Code <b>Haha</b></span></div>
      <p>{c.footer}</p>
      <div className="footer-links">
        <a href={locale === 'en' ? '/en/desktop/01-quick-start' : '/desktop/01-quick-start'}>Docs</a>
        <a href={GITHUB_URL}><Icon name="github" size={17} />GitHub</a>
        <a href={locale === 'en' ? '/' : '/en/'}>{locale === 'en' ? '中文' : 'English'}</a>
      </div>
    </footer>
  )
}

export default function HomePage({ locale = 'zh' }) {
  const c = content[locale]
  const pageRef = useReveal()

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
    document.title = locale === 'en'
      ? 'Claude Code Haha — A studio for Claude Code'
      : 'Claude Code Haha — Claude Code 的桌面工作室'
  }, [locale])

  return (
    <div className="home" ref={pageRef}>
      <a className="skip-link" href="#journey">Skip to content</a>
      <Header locale={locale} c={c} />
      <main>
        <Hero locale={locale} c={c} />
        <Journey c={c} />
        <ProductTour c={c} />
        <Crew c={c} />
        <Guide c={c} />
        <Install locale={locale} c={c} />
      </main>
      <Footer locale={locale} c={c} />
    </div>
  )
}
