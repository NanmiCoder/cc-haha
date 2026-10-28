import { execFileSync } from 'node:child_process'
import { test } from 'bun:test'

test('profile shows uploaded identity, while missing identity is explained beside its placeholder and can retry', () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const React = await import(${JSON.stringify(import.meta.resolve('react'))})
    mock.module(${JSON.stringify(import.meta.resolve('react'))}, () => ({ ...React, useMemo: fn => fn(), useState: initial => [initial, () => {}] }))
    mock.module(${JSON.stringify(import.meta.resolve('react-native'))}, () => ({ Image: 'Image', View: 'View', Pressable: 'Pressable', Linking: { openURL: async () => {} } }))
    mock.module(${JSON.stringify(import.meta.resolve('../kit'))}, () => ({ EmptyState: 'EmptyState', Footnote: 'Footnote', InlineError: 'InlineError', Mono: 'Mono', SectionHeader: 'SectionHeader', Button: 'Button', Icon: 'Icon', useColors: () => ({}) }))
    mock.module(${JSON.stringify(import.meta.resolve('../Logo'))}, () => ({ Logo: 'Logo' }))
    mock.module(${JSON.stringify(import.meta.resolve('../Text'))}, () => ({ Text: 'Text' }))
    const { ProfileContent } = await import(${JSON.stringify(import.meta.resolve('./ProfileContent'))})
    const flatten = node => {
      if (Array.isArray(node)) return node.flatMap(flatten)
      if (!node || typeof node !== 'object') return []
      if (typeof node.type === 'function') return flatten(node.type(node.props))
      return [node, ...flatten(node.props?.children)]
    }
    const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3cAAAAASUVORK5CYII='
    const profile = { displayName: '上传头像的用户', subtitle: 'github.com/example/profile', avatarDataUrl }
    let retries = 0
    const props = { overview: { profile, stats: null, profileError: '', statsError: '' }, onRetry: () => retries++ }
    let nodes = flatten(ProfileContent(props))
    assert.equal(nodes.find(node => node.type === 'Image').props.source.uri, avatarDataUrl)
    assert.ok(nodes.some(node => node.props.children === profile.displayName))
    assert.equal(nodes.some(node => node.type === 'Logo'), false)
    props.overview.profile = null
    props.overview.profileError = '请更新电脑端以同步头像和昵称。'
    nodes = flatten(ProfileContent(props))
    assert.ok(nodes.some(node => node.props.children === '资料未同步'))
    assert.ok(nodes.some(node => node.props.children === props.overview.profileError || node.props.text === props.overview.profileError))
    assert.equal(nodes.some(node => node.type === 'Logo'), false)
    nodes.find(node => node.type === 'Button' && node.props.title === '重新同步').props.onPress()
    assert.equal(retries, 1)
  `
  execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
})
