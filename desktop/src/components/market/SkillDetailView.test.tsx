import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-renderer" data-content={content} data-variant={variant} />
  ),
}))

vi.mock('../chat/CodeViewer', () => ({
  CodeViewer: ({ code, showLineNumbers }: { code: string; showLineNumbers?: boolean }) => (
    <div data-testid="code-viewer" data-line-numbers={String(showLineNumbers)}>{code}</div>
  ),
}))

import { SkillDetailView } from './SkillDetailView'
import { useSettingsStore } from '../../stores/settingsStore'
import type { PreviewFileContent } from './FilePreview'

const FILES = [
  { path: 'SKILL.md', size: 100, language: 'markdown' },
  { path: 'scripts/run.py', size: 200, language: 'python' },
]

function loadFileFromMemory(path: string): Promise<PreviewFileContent> {
  if (path === 'SKILL.md') {
    return Promise.resolve({ path, content: '# Overview doc', language: 'markdown', size: 100, truncated: false })
  }
  return Promise.resolve({ path, content: 'print("hi")', language: 'python', size: 200, truncated: true })
}

function renderView(overrides: Partial<Parameters<typeof SkillDetailView>[0]> = {}) {
  return render(
    <SkillDetailView
      name="Demo Skill"
      version="1.0.0"
      sourceLabel="ClawHub"
      summary="A demo"
      securityStatus="benign"
      installState="installable"
      meta={[{ label: 'Author', value: 'Alice' }]}
      description="# Body"
      files={FILES}
      loadFile={loadFileFromMemory}
      onBack={vi.fn()}
      backLabel="Back"
      {...overrides}
    />,
  )
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('SkillDetailView', () => {
  it('renders the decision header with badges and the overview markdown', () => {
    renderView()

    expect(screen.getByText('Demo Skill')).toBeInTheDocument()
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    expect(screen.getByTestId('security-badge-benign')).toBeInTheDocument()
    expect(screen.getByTestId('install-badge-installable')).toBeInTheDocument()
    const markdown = screen.getByTestId('markdown-renderer')
    expect(markdown).toHaveAttribute('data-content', '# Body')
    expect(markdown).toHaveAttribute('data-variant', 'document')
  })

  it('shows the not-installable reason prominently', () => {
    renderView({ installState: 'not-installable', notInstallableReason: 'name-conflict' })

    expect(screen.getByTestId('market-not-installable-reason')).toHaveTextContent(
      'A local skill with the same name already exists',
    )
  })

  it('lists security reports with links', () => {
    renderView({
      securityReports: [
        { vendor: 'keen', status: 'benign', statusText: 'Safe', reportUrl: 'https://example.com/report' },
      ],
    })

    expect(screen.getByTestId('market-security-reports')).toHaveTextContent('keen')
    expect(screen.getByRole('link', { name: 'View report' })).toHaveAttribute('href', 'https://example.com/report')
  })

  it('switches to the files tab and previews code with line numbers and truncation notice', async () => {
    renderView()

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))
    expect(await screen.findByTestId('market-file-preview')).toBeInTheDocument()
    // SKILL.md is auto-selected → markdown preview
    expect(await screen.findAllByTestId('markdown-renderer')).toBeTruthy()

    fireEvent.click(screen.getByTestId('market-file-item-scripts/run.py'))
    const code = await screen.findByTestId('code-viewer')
    expect(code).toHaveTextContent('print("hi")')
    expect(code).toHaveAttribute('data-line-numbers', 'true')
    expect(screen.getByText(/Preview truncated/)).toBeInTheDocument()
  })

  it('shows a file load error with retry', async () => {
    const failingLoad = vi.fn().mockRejectedValue(new Error('fetch failed'))
    renderView({ loadFile: failingLoad })

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))
    expect(await screen.findByTestId('market-file-error')).toHaveTextContent('Failed to load this file')
    expect(screen.getByText('fetch failed')).toBeInTheDocument()
  })

  it('renders custom actions in the decision area', () => {
    renderView({ actions: <button type="button">Install now</button> })

    const decisionSidebar = screen.getByTestId('skill-detail-sidebar')
    expect(within(decisionSidebar).getByText('Install now')).toBeInTheDocument()
    expect(within(decisionSidebar).getByText('Author')).toBeInTheDocument()
    expect(within(decisionSidebar).getByText('Alice')).toBeInTheDocument()
  })

  it('lifts SKILL.md frontmatter out of the overview markdown into the sidebar rail', () => {
    renderView({
      description: ['---', 'name: find-skills', 'model: opus', 'tags: ["a","b"]', '---', '', '# Body'].join('\n'),
    })

    // The YAML must not reach the renderer — markdown turns it into a heading.
    expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-content', '# Body')

    // Metadata is reference material: it sits with the other attributes, and
    // never ahead of the document that says what the skill does.
    const overview = screen.getByTestId('skill-detail-overview')
    expect(within(overview).queryByTestId('skill-frontmatter-panel')).not.toBeInTheDocument()

    const panel = within(screen.getByTestId('skill-detail-sidebar')).getByTestId('skill-frontmatter-panel')
    expect(within(panel).getByText('model')).toBeInTheDocument()
    expect(within(panel).getByText('opus')).toBeInTheDocument()
    // `name` duplicates the header, so it is filtered out.
    expect(within(panel).queryByText('name')).not.toBeInTheDocument()
  })

  it('keeps the metadata rail below the market meta it belongs with', () => {
    renderView({
      description: '---\nmodel: opus\n---\n# Body',
      meta: [{ label: 'Author', value: 'Alice' }],
    })

    const sidebar = screen.getByTestId('skill-detail-sidebar')
    const author = within(sidebar).getByText('Author')
    const panel = within(sidebar).getByTestId('skill-frontmatter-panel')

    expect(author.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows frontmatter the caller parsed upstream when the description has none', () => {
    renderView({ description: '# Body', descriptionFrontmatter: { model: 'opus' } })

    expect(screen.getByTestId('skill-frontmatter-panel')).toHaveTextContent('opus')
    expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-content', '# Body')
  })

  it('prefers frontmatter embedded in the description over the caller-supplied copy', () => {
    renderView({
      description: '---\nmodel: sonnet\n---\n# Body',
      descriptionFrontmatter: { model: 'opus' },
    })

    const panel = screen.getByTestId('skill-frontmatter-panel')
    expect(panel).toHaveTextContent('sonnet')
    expect(panel).not.toHaveTextContent('opus')
  })

  it('omits the metadata panel when there is no frontmatter at all', () => {
    renderView({ description: '# Body' })

    expect(screen.queryByTestId('skill-frontmatter-panel')).not.toBeInTheDocument()
  })

  it('still shows the empty-description notice when only frontmatter is present', () => {
    renderView({ description: '---\nmodel: opus\n---\n' })

    expect(screen.getByText('This skill provides no description.')).toBeInTheDocument()
    expect(screen.getByTestId('skill-frontmatter-panel')).toBeInTheDocument()
  })

  it('splits frontmatter out of markdown files in the files tab too', async () => {
    const loadFile = (path: string) =>
      Promise.resolve({
        path,
        content: '---\nmodel: opus\n---\n# Skill body',
        language: 'markdown',
        size: 42,
        truncated: false,
      })
    // No sidebar copy here, so the only panel found must be the file's own.
    renderView({ loadFile, description: '# Overview', meta: [] })

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))

    const preview = await screen.findByTestId('market-file-preview')
    expect(await within(preview).findByTestId('skill-frontmatter-panel')).toHaveTextContent('opus')
    const rendered = await screen.findAllByTestId('markdown-renderer')
    expect(rendered.some((node) => node.getAttribute('data-content') === '# Skill body')).toBe(true)
  })

  it('lets the files tab fill the available height instead of a fixed-height box', async () => {
    renderView()

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))

    // A hard-coded max-height left the lower half of the page empty; the panel
    // now grows with its flex parent.
    const preview = await screen.findByTestId('market-file-preview')
    expect(screen.getByTestId('skill-detail-files').className).toContain('flex-1')
    expect(preview.className).toContain('flex-1')
    expect(preview.className).not.toContain('max-h-[520px]')
  })
})

describe('SkillDetailView market extensions', () => {
  it('keeps the installed-skill layout when none of the optional props are passed', async () => {
    // The installed page passes none of them: source label above the title,
    // default badges, actions in the side rail, and the rail on every tab.
    renderView({ actions: <button type="button">Uninstall</button> })

    expect(screen.getByText('ClawHub')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-detail-meta-line')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-detail-stats')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-detail-hero-actions')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('skill-detail-sidebar')).getByText('Uninstall')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))
    expect(await screen.findByTestId('market-file-preview')).toBeInTheDocument()
    expect(screen.getByTestId('skill-detail-sidebar')).toBeInTheDocument()
  })

  it('shows the version as a pill beside the title', () => {
    renderView()

    const heading = screen.getByRole('heading', { level: 1, name: 'Demo Skill' })
    expect(heading.parentElement).toContainElement(screen.getByTestId('skill-detail-version'))
    expect(screen.getByTestId('skill-detail-version')).toHaveTextContent('v1.0.0')
  })

  it('renders the meta line, custom chips and the stats strip', () => {
    renderView({
      metaLine: <span>by Alice · ClawHub</span>,
      chips: <span data-testid="custom-chip">Featured</span>,
      stats: [
        { label: 'Downloads', value: '482.1k' },
        { label: 'Files', value: '15' },
      ],
    })

    expect(screen.getByTestId('skill-detail-meta-line')).toHaveTextContent('by Alice · ClawHub')
    expect(screen.getByTestId('custom-chip')).toBeInTheDocument()
    // Custom chips replace the default badge row rather than adding to it.
    expect(screen.queryByTestId('security-badge-benign')).not.toBeInTheDocument()
    const stats = screen.getByTestId('skill-detail-stats')
    expect(within(stats).getByText('Downloads')).toBeInTheDocument()
    expect(within(stats).getByText('482.1k')).toBeInTheDocument()
  })

  it('adds extra tabs with their badges and switches to them', () => {
    renderView({
      extraTabs: [
        { key: 'security', label: 'Security report', badge: <span data-testid="flag-dot" />, content: <p>Scan results</p> },
      ],
    })

    const securityTab = screen.getByRole('tab', { name: 'Security report' })
    expect(within(securityTab).getByTestId('flag-dot')).toBeInTheDocument()

    fireEvent.click(securityTab)
    expect(securityTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('skill-detail-security')).toHaveTextContent('Scan results')
    expect(screen.queryByTestId('skill-detail-overview')).not.toBeInTheDocument()
  })

  it('follows a controlled tab and reports clicks without switching by itself', () => {
    const onTabChange = vi.fn()
    const { rerender } = renderView({
      activeTab: 'overview',
      onTabChange,
      extraTabs: [{ key: 'changelog', label: 'Changelog', content: <p>v2 notes</p> }],
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Changelog' }))
    expect(onTabChange).toHaveBeenCalledWith('changelog')
    expect(screen.getByTestId('skill-detail-overview')).toBeInTheDocument()

    rerender(
      <SkillDetailView
        name="Demo Skill"
        sourceLabel="ClawHub"
        meta={[]}
        description="# Body"
        files={FILES}
        loadFile={loadFileFromMemory}
        onBack={vi.fn()}
        backLabel="Back"
        activeTab="changelog"
        onTabChange={onTabChange}
        extraTabs={[{ key: 'changelog', label: 'Changelog', content: <p>v2 notes</p> }]}
      />,
    )
    expect(screen.getByTestId('skill-detail-changelog')).toHaveTextContent('v2 notes')
  })

  it('puts hero actions in the header and gives non-overview tabs the full width', () => {
    renderView({
      actionsPlacement: 'hero',
      actions: <button type="button">Install</button>,
      extraTabs: [{ key: 'security', label: 'Security report', content: <p>Scan results</p> }],
    })

    expect(within(screen.getByTestId('skill-detail-hero-actions')).getByText('Install')).toBeInTheDocument()
    expect(within(screen.getByTestId('skill-detail-sidebar')).queryByText('Install')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Security report' }))
    expect(screen.queryByTestId('skill-detail-sidebar')).not.toBeInTheDocument()
  })

  it('renders the overview lead above the document, the doc header and the side cards', () => {
    renderView({
      overviewLead: <div data-testid="lead-panel" />,
      docHeader: <span>SKILL.md · 2 KB</span>,
      sideCards: <section data-testid="side-card" />,
      metaTitle: 'Info',
    })

    const lead = screen.getByTestId('lead-panel')
    const overview = screen.getByTestId('skill-detail-overview')
    expect(lead.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(overview).getByTestId('skill-detail-doc-header')).toHaveTextContent('SKILL.md · 2 KB')

    const sidebar = screen.getByTestId('skill-detail-sidebar')
    expect(within(sidebar).getByTestId('side-card')).toBeInTheDocument()
    expect(within(sidebar).getByRole('heading', { name: 'Info' })).toBeInTheDocument()
  })

  it('splits into document and rail by its own width, not the window', () => {
    // The same view fills the extensions page and sits in the 700px settings
    // pane; a viewport breakpoint put a 280px rail beside the document there.
    renderView()
    const view = screen.getByTestId('skill-detail-view')
    expect(view.className).toContain('@container')
    const columns = screen.getByTestId('skill-detail-sidebar').parentElement!
    expect(columns.className).toContain('@4xl:grid-cols-[minmax(0,1fr)_280px]')
    expect(columns.className).not.toMatch(/(^|\s)lg:grid-cols/)
  })

  it('lets a host that already lays out a page column skip the view\'s own', () => {
    const { unmount } = renderView()
    expect(screen.getByTestId('skill-detail-view').firstElementChild!.className).toContain('max-w-[1200px]')
    unmount()
    renderView({ framed: true })
    expect(screen.getByTestId('skill-detail-view').firstElementChild!.className).not.toContain('max-w-')
  })
})
