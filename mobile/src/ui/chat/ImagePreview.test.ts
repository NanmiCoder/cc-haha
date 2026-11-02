import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

function checkPreview(platform: 'web' | 'native') {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = require(${JSON.stringify(import.meta.resolve('react'))})
    let state = [], cursor = 0, closed = 0, retries = 0
    const status = { failed: false, attempt: 0, retry: () => { retries++; status.attempt++ } }
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({
      ...React, default: React,
      useState: initial => {
        const slot = cursor++
        if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
        return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
      },
      useEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn,
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({
      Image: 'Image', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View',
    }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native-image-viewing'))}, () => ({ default: 'NativeImageView' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    mock.module(${JSON.stringify(import.meta.resolve('./ImagePreviewChrome'))}, () => ({
      ImagePreviewHeader: 'Header', ImagePreviewNavigation: 'Navigation', ImagePreviewError: 'Error', imagePreviewColors: { bg: '#000', ink: '#fff' },
    }))
    mock.module(${JSON.stringify(import.meta.resolve('./imagePreviewStatus'))}, () => ({ useImagePreviewStatus: () => status }))
    const { ImagePreview } = require(${JSON.stringify(import.meta.resolve(platform === 'native' ? './ImagePreview.native' : './ImagePreview'))})
    const images = [0, 1, 2].map(index => ({ id: 'image-' + index, name: '照片' + index, uri: 'file:///image-' + index + '.jpg', attachmentIndex: index }))
    const props = { images, initialIndex: 1, onClose: () => closed++ }
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      return [node, ...flatten(node.props?.children)]
    }
    const render = () => { cursor = 0; return ImagePreview(props) }
    let root = render()
    if (${JSON.stringify(platform)} === 'native') {
      assert.equal(root.type, 'NativeImageView')
      assert.deepEqual(root.props.images, images.map(image => ({ uri: image.uri })))
      assert.equal(root.props.imageIndex, 1)
      assert.equal(root.props.doubleTapToZoomEnabled, true)
      assert.equal(root.props.swipeToCloseEnabled, true)
      assert.equal(root.props.keyExtractor(root.props.images[1], 1), 'image-1')
      assert.equal(root.props.HeaderComponent({ imageIndex: 1 }).props.image.name, '照片1')
      const originalKey = root.key
      root.props.onImageIndexChange(0)
      root = render()
      let footer = flatten(root.props.FooterComponent({ imageIndex: 0 }))
      footer.find(node => node.type === 'Navigation').props.onSelect(1)
      root = render()
      assert.equal(root.props.imageIndex, 1)
      assert.notEqual(root.key, originalKey, 'swipe away then navigate back to the opening index must still move the native gallery')
      root.props.onImageIndexChange(2)
      root = render()
      assert.equal(root.props.imageIndex, 1, 'a swipe must not remount the gallery at the original picture')
      footer = flatten(root.props.FooterComponent({ imageIndex: 2 }))
      footer.find(node => node.type === 'Navigation').props.onSelect(0)
      root = render()
      assert.equal(root.props.imageIndex, 0)
      status.failed = true
      root = render()
      footer = flatten(root.props.FooterComponent({ imageIndex: 0 }))
      footer.find(node => node.type === 'Error').props.onRetry()
      assert.equal(retries, 1)
      root = render()
      assert.equal(root.key, '2:1', 'retry must remount the library and reset its failed image state')
      assert.equal(root.props.imageIndex, 0, 'retry must keep the selected picture')
      root.props.onRequestClose()
      assert.equal(closed, 1, 'Android back/native swipe dismissal must close the gallery')
    } else {
      let nodes = flatten(root)
      assert.equal(nodes.find(node => node.type === 'Image').props.source.uri, images[1].uri)
      nodes.find(node => node.type === 'View' && node.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 393, height: 600 } } })
      nodes = flatten(render())
      nodes.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '放大图片').props.onPress()
      nodes = flatten(render())
      assert.equal(nodes.find(node => node.type === 'Image').props.style.width, 786)
      assert.equal(nodes.find(node => node.type === 'Image').props.style.height, 1200)
      nodes.find(node => node.type === 'Navigation').props.onSelect(2)
      nodes = flatten(render())
      assert.equal(nodes.find(node => node.type === 'Image').props.source.uri, images[2].uri)
      assert.equal(nodes.find(node => node.type === 'Image').props.style.width, 393, 'selecting another image resets zoom')
      nodes.find(node => node.type === 'Image').props.onError()
      nodes = flatten(render())
      nodes.find(node => node.type === 'Error').props.onRetry()
      nodes = flatten(render())
      assert.equal(nodes.find(node => node.type === 'Image').props.source.uri, images[2].uri)
      assert.ok(nodes.some(node => node.type === 'ScrollView' && node.key === '2:1'))
      nodes.find(node => node.type === 'Header').props.onClose()
      assert.equal(closed, 1)
    }
  `
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(String((error as { stderr?: Buffer }).stderr || error))
  }
}

test('native viewer preserves swiping, zoom, image identity, retry and Android dismissal', () => checkPreview('native'))
test('browser viewer opens full images, zooms, changes pictures and recovers from errors', () => checkPreview('web'))
