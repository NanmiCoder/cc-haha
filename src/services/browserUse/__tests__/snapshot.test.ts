import { describe, expect, it } from 'bun:test'
import {
  SnapshotRefStore,
  buildNonMutatingDomScanExpression,
  capturePageSnapshot,
  compactAccessibilityTree,
  computeSnapshotDiff,
  type RawAxNode,
} from '../snapshot'
import { MockCdpTransport } from './mockCdpTransport'

describe('browserUse/snapshot', () => {
  it('compacts AXTree, filters workspace zoom & preview overlays, redacts passwords, promotes hidden labels, and adds hints', () => {
    const refStore = new SnapshotRefStore()
    const axNodes: RawAxNode[] = [
      {
        nodeId: 'root',
        role: { value: 'RootWebArea' },
        name: { value: 'Checkout' },
        childIds: ['zoomOverlay', 'header', 'passwordField', 'submitBtn'],
      },
      {
        nodeId: 'zoomOverlay',
        parentId: 'root',
        backendDOMNodeId: 999,
        role: { value: 'region' },
        name: { value: 'Zoom Controls' },
        childIds: ['zoomBtn'],
      },
      {
        nodeId: 'zoomBtn',
        parentId: 'zoomOverlay',
        backendDOMNodeId: 1000,
        role: { value: 'button' },
        name: { value: 'Zoom In' },
      },
      {
        nodeId: 'header',
        parentId: 'root',
        role: { value: 'heading' },
        name: { value: 'Order Summary' },
        properties: [{ name: 'level', value: { value: 1 } }],
      },
      {
        nodeId: 'passwordField',
        parentId: 'root',
        backendDOMNodeId: 201,
        role: { value: 'textbox' },
        name: { value: 'Account Password' },
        value: { value: 'my-real-secret-123' },
      },
      {
        nodeId: 'submitBtn',
        parentId: 'root',
        backendDOMNodeId: 202,
        role: { value: 'button' },
        name: { value: '提交订单' },
      },
    ]

    const result = compactAccessibilityTree({
      nodes: axNodes,
      domScan: {
        excludedBackendNodeIds: new Set([999]),
        passwordBackendNodeIds: new Set([201]),
        hintByBackendNodeId: new Map([[202, 'icon:check; in:form #checkout']]),
        candidates: [
          {
            backendNodeId: 301,
            role: 'checkbox',
            name: 'Agree to terms',
            tagName: 'label',
            inputType: 'checkbox',
            checked: false,
            hint: 'in:form #checkout',
            source: 'label',
          },
          {
            backendNodeId: 302,
            role: 'button',
            name: 'Custom Card Toggle',
            tagName: 'div',
            hint: 'in:main',
            source: 'dom',
          },
        ],
      },
      frameId: 'frame-1',
      loaderId: 'loader-1',
      refStore,
    })

    // Zoom overlay and its children MUST be excluded
    expect(result.treeText).not.toContain('Zoom In')
    expect(result.treeText).not.toContain('Zoom Controls')
    expect(result.refs.some(r => r.backendNodeId === 1000)).toBe(false)

    // Password value MUST be redacted
    expect(result.treeText).not.toContain('my-real-secret-123')
    expect(result.treeText).toContain('[REDACTED]')
    const pwRef = result.refs.find(r => r.backendNodeId === 201)
    expect(pwRef?.isPassword).toBe(true)
    expect(pwRef?.value).toBe('[REDACTED]')

    // Disambiguation hint & humanLabel present
    const submitRef = result.refs.find(r => r.backendNodeId === 202)
    expect(submitRef?.hint).toBe('icon:check; in:form #checkout')
    expect(submitRef?.humanLabel).toBe('提交订单')

    // Hidden checkbox <label> promotion & cursor-interactive DOM candidate included
    expect(result.refs.find(r => r.backendNodeId === 301)?.source).toBe('label')
    expect(result.refs.find(r => r.backendNodeId === 302)?.source).toBe('dom')
  })

  it('uses monotonic never-recycled @eN refs scoped by (tabId, frameId, loaderId)', async () => {
    const transport = new MockCdpTransport('workspace')
    let loaderId = 'loader-1'
    transport.onCommand('Page.getFrameTree', () => ({
      frameTree: {
        frame: { id: 'frame-1', loaderId, url: 'https://example.com/a' },
      },
    }))
    transport.onCommand('Accessibility.getFullAXTree', () => ({
      nodes: [
        {
          nodeId: 'n1',
          backendDOMNodeId: 10,
          role: { value: 'button' },
          name: { value: 'Continue' },
        },
      ],
    }))
    transport.onCommand('Runtime.evaluate', params => {
      if (String(params?.expression).includes('document.title')) {
        return { result: { value: 'Page A' } }
      }
      return { result: { value: { candidates: [] } } }
    })

    const refStore = new SnapshotRefStore()
    const snap1 = await capturePageSnapshot({
      transport,
      tabId: 'tab-1',
      target: 'workspace',
      refStore,
    })
    expect(snap1.refs.map(r => r.refId)).toEqual(['@e1'])
    expect(refStore.getRef('tab-1', '@e1', 'frame-1', 'loader-1')).toBeDefined()
    expect(refStore.getRef('tab-1', '@e1', 'frame-1', 'loader-2')).toBeUndefined()

    // Second snapshot allocates @e2 (never recycles @e1)
    loaderId = 'loader-2'
    const snap2 = await capturePageSnapshot({
      transport,
      tabId: 'tab-1',
      target: 'workspace',
      refStore,
    })
    expect(snap2.refs.map(r => r.refId)).toEqual(['@e2'])
    expect(refStore.getRef('tab-1', '@e1')).toBeUndefined()
    expect(refStore.getRef('tab-1', '@e2', 'frame-1', 'loader-2')).toBeDefined()

    // Verify Runtime.releaseObjectGroup is always called for cleanup
    expect(
      transport.commands.some(c => c.method === 'Runtime.releaseObjectGroup'),
    ).toBe(true)
  })

  it('detects pre/post Page.getFrameTree loaderId race and retries once', async () => {
    const transport = new MockCdpTransport('workspace')
    let frameTreeCalls = 0
    transport.onCommand('Page.getFrameTree', () => {
      frameTreeCalls += 1
      // Attempt 1: pre=L1, post=L2 (race!). Attempt 2: pre=L2, post=L2 (stable!)
      const loaderId = frameTreeCalls === 1 ? 'L1' : 'L2'
      return {
        frameTree: {
          frame: { id: 'f1', loaderId, url: 'https://example.com' },
        },
      }
    })
    transport.onCommand('Accessibility.getFullAXTree', () => ({
      nodes: [
        {
          nodeId: 'b1',
          backendDOMNodeId: 55,
          role: { value: 'button' },
          name: { value: 'Save' },
        },
      ],
    }))
    transport.onCommand('Runtime.evaluate', () => ({ result: { value: '' } }))

    const refStore = new SnapshotRefStore()
    const snap = await capturePageSnapshot({
      transport,
      tabId: 'tab-race',
      target: 'workspace',
      refStore,
    })
    expect(frameTreeCalls).toBe(4)
    expect(snap.loaderId).toBe('L2')
    expect(snap.refs).toHaveLength(1)
  })

  it('supports diff: true line diffing and bounded screenshot compression', async () => {
    const transport = new MockCdpTransport('workspace')
    let buttonName = 'Add to Cart'
    const screenshotQualities: number[] = []

    transport.onCommand('Page.getFrameTree', () => ({
      frameTree: {
        frame: { id: 'f1', loaderId: 'L1', url: 'https://shop.test' },
      },
    }))
    transport.onCommand('Accessibility.getFullAXTree', () => ({
      nodes: [
        {
          nodeId: 'b1',
          backendDOMNodeId: 77,
          role: { value: 'button' },
          name: { value: buttonName },
        },
      ],
    }))
    transport.onCommand('Runtime.evaluate', () => ({ result: { value: 'Shop' } }))
    transport.onCommand('Page.captureScreenshot', params => {
      const q = Number(params?.quality ?? 72)
      screenshotQualities.push(q)
      // Simulate large payload at high quality, smaller at lower quality
      const size = q >= 60 ? 2000 : 120
      return { data: 'A'.repeat(size) }
    })

    const refStore = new SnapshotRefStore()
    await capturePageSnapshot({
      transport,
      tabId: 'tab-diff',
      target: 'workspace',
      refStore,
    })

    buttonName = 'Added (1)'
    const snap2 = await capturePageSnapshot({
      transport,
      tabId: 'tab-diff',
      target: 'workspace',
      refStore,
      options: {
        diff: true,
        screenshot: true,
        maxScreenshotBytes: 300,
      },
    })

    expect(snap2.diffChanged).toBe(true)
    expect(snap2.diff).toContain('- - @e1 [button] "Add to Cart"')
    expect(snap2.diff).toContain('+ - @e2 [button] "Added (1)"')
    expect(screenshotQualities.length).toBeGreaterThanOrEqual(2)
    expect(snap2.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(snap2.screenshotBytes).toBeLessThanOrEqual(300)
  })

  it('keeps DOM scan script strictly non-mutating and overlay-aware', () => {
    const expr = buildNonMutatingDomScanExpression()
    expect(expr).toContain('data-workspace-browser-zoom="true"')
    expect(expr).toContain('shadowRoot')
    expect(expr).not.toContain('setAttribute(')
    expect(expr).not.toContain('innerHTML')

    const same = computeSnapshotDiff('a\nb', 'a\nb')
    expect(same.changed).toBe(false)
  })
})
