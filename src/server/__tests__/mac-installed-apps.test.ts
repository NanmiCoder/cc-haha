import { describe, expect, it } from 'bun:test'
import { listInstalledMacApps } from '../api/macInstalledApps.js'

type FakeEntry = {
  name: string
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
}

function entry(name: string, options: { directory?: boolean; symlink?: boolean } = {}): FakeEntry {
  return {
    name,
    isDirectory: () => options.directory ?? true,
    isSymbolicLink: () => options.symlink ?? false,
  }
}

describe('macOS installed app enumeration', () => {
  it('never descends into an app bundle after collecting it', async () => {
    const metadataReads: string[] = []
    const apps = await listInstalledMacApps({
      roots: ['/Applications'],
      readDirectory: async path => {
        if (path === '/Applications') {
          return [entry('Notes.app'), entry('Folder'), entry('Alias.app', { symlink: true })]
        }
        return []
      },
      canonicalize: async path => path,
      readMetadata: async appPath => {
        metadataReads.push(appPath)
        return { bundleId: 'com.example.notes', displayName: 'Notes' }
      },
    })

    expect(apps).toEqual([
      { bundleId: 'com.example.notes', displayName: 'Notes', path: '/Applications/Notes.app' },
    ])
    expect(metadataReads).toEqual(['/Applications/Notes.app'])
  })

  it('recurses through ordinary folders to find categorized applications', async () => {
    const apps = await listInstalledMacApps({
      roots: ['/Applications'],
      readDirectory: async directory => {
        if (directory === '/Applications') return [entry('Setapp')]
        if (directory === '/Applications/Setapp') return [entry('Writer.app')]
        throw new Error(`unexpected recursion into ${directory}`)
      },
      canonicalize: async path => path,
      readMetadata: async appPath => ({
        bundleId: 'com.example.writer',
        displayName: 'Writer',
      }),
    })

    expect(apps).toEqual([{
      bundleId: 'com.example.writer',
      displayName: 'Writer',
      path: '/Applications/Setapp/Writer.app',
    }])
  })

  it('ignores symlinks and canonical app paths that escape an allowlisted root', async () => {
    const apps = await listInstalledMacApps({
      roots: ['/Applications'],
      readDirectory: async () => [
        entry('Safe.app'),
        entry('Outside.app'),
        entry('Link.app', { symlink: true }),
        entry('../Traversal.app'),
      ],
      canonicalize: async path => {
        if (path.endsWith('Outside.app')) return '/tmp/Outside.app'
        return path
      },
      readMetadata: async appPath => ({
        bundleId: `id.${appPath.split('/').at(-1)}`,
        displayName: appPath.split('/').at(-1) ?? '',
      }),
    })

    expect(apps.map(app => app.path)).toEqual(['/Applications/Safe.app'])
  })

  it('deduplicates bundle IDs and returns a stable display-name order', async () => {
    const apps = await listInstalledMacApps({
      roots: ['/Applications', '/System/Applications'],
      readDirectory: async root => root === '/Applications'
        ? [entry('Zed.app'), entry('Duplicate.app')]
        : [entry('Alpha.app')],
      canonicalize: async path => path,
      readMetadata: async appPath => {
        if (appPath.endsWith('Zed.app')) {
          return { bundleId: 'com.example.zed', displayName: 'Zed' }
        }
        if (appPath.endsWith('Duplicate.app')) {
          return { bundleId: 'com.example.alpha', displayName: 'Duplicate' }
        }
        return { bundleId: 'com.example.alpha', displayName: 'Alpha' }
      },
    })

    expect(apps).toEqual([
      {
        bundleId: 'com.example.alpha',
        displayName: 'Duplicate',
        path: '/Applications/Duplicate.app',
      },
      {
        bundleId: 'com.example.zed',
        displayName: 'Zed',
        path: '/Applications/Zed.app',
      },
    ])
  })

  it('includes the built-in host, helper, and an additional configured host like any other app', async () => {
    const metadata = new Map([
      ['Desktop.app', { bundleId: 'com.claude-code-haha.desktop', displayName: 'Claude Code Haha' }],
      ['Helper.app', { bundleId: 'dev.cchaha.cu-helper', displayName: 'Computer Use Helper' }],
      ['Custom.app', { bundleId: 'com.example.custom-host', displayName: 'Custom Host' }],
      ['Notes.app', { bundleId: 'com.example.notes', displayName: 'Notes' }],
    ])
    const previousHost = process.env.CC_HAHA_COMPUTER_USE_HOST_BUNDLE_ID
    process.env.CC_HAHA_COMPUTER_USE_HOST_BUNDLE_ID = 'com.example.custom-host'
    let apps: Awaited<ReturnType<typeof listInstalledMacApps>>
    try {
      apps = await listInstalledMacApps({
        roots: ['/Applications'],
        readDirectory: async () => [...metadata.keys()].map(name => entry(name)),
        canonicalize: async candidate => candidate,
        readMetadata: async appPath => metadata.get(appPath.split('/').at(-1) ?? '') ?? null,
      })
    } finally {
      if (previousHost === undefined) delete process.env.CC_HAHA_COMPUTER_USE_HOST_BUNDLE_ID
      else process.env.CC_HAHA_COMPUTER_USE_HOST_BUNDLE_ID = previousHost
    }

    expect(apps).toEqual([
      {
        bundleId: 'com.claude-code-haha.desktop',
        displayName: 'Claude Code Haha',
        path: '/Applications/Desktop.app',
      },
      {
        bundleId: 'dev.cchaha.cu-helper',
        displayName: 'Computer Use Helper',
        path: '/Applications/Helper.app',
      },
      {
        bundleId: 'com.example.custom-host',
        displayName: 'Custom Host',
        path: '/Applications/Custom.app',
      },
      {
        bundleId: 'com.example.notes',
        displayName: 'Notes',
        path: '/Applications/Notes.app',
      },
    ])
  })
})
