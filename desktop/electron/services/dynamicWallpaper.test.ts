import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_DYNAMIC_WALLPAPER,
  clearDynamicWallpaperSource,
  normalizeDynamicWallpaperPreferences,
  pickVideoWallpaper,
  pickWebWallpaper,
  readDynamicWallpaperPreferences,
  reloadDynamicWallpaper,
  resolveDynamicWallpaperStatus,
  updateDynamicWallpaperPreferences,
  wallpaperConfigPath,
  writeDynamicWallpaperPreferences,
} from './dynamicWallpaper'

let root: string
const app = { getPath: () => root }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-wallpaper-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writeVideo(name = 'loop.mp4'): string {
  const file = path.join(root, name)
  fs.writeFileSync(file, 'video-bytes')
  return file
}

function writePack(name = 'pack'): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>')
  return dir
}

describe('dynamic wallpaper preferences', () => {
  it('falls back to defaults when the config is missing or unreadable', () => {
    expect(readDynamicWallpaperPreferences(app)).toEqual(DEFAULT_DYNAMIC_WALLPAPER)
    fs.writeFileSync(wallpaperConfigPath(app), '{not json')
    expect(readDynamicWallpaperPreferences(app)).toEqual(DEFAULT_DYNAMIC_WALLPAPER)
  })

  it('normalizes malformed values instead of trusting the file', () => {
    const normalized = normalizeDynamicWallpaperPreferences({
      kind: 'remote',
      enabled: 'yes',
      focusX: 500,
      focusY: -20,
      zoom: 5,
      blur: 999,
      panelOpacity: 10,
      videoPath: 'relative.mp4',
      webDir: 42,
      revision: -1,
    })
    expect(normalized).toMatchObject({
      kind: 'image',
      enabled: false,
      focusX: 100,
      focusY: 0,
      zoom: 100,
      blur: 40,
      panelOpacity: 60,
      videoPath: null,
      videoName: null,
      webDir: null,
      webName: null,
      revision: 0,
    })
  })

  it('round-trips a written config and keeps only normalized fields', () => {
    writeDynamicWallpaperPreferences(app, {
      ...DEFAULT_DYNAMIC_WALLPAPER,
      kind: 'video',
      enabled: true,
      videoPath: writeVideo(),
      extra: 'ignored',
    } as never)

    const stored = JSON.parse(fs.readFileSync(wallpaperConfigPath(app), 'utf8'))
    expect(stored.extra).toBeUndefined()
    expect(stored).toMatchObject({ kind: 'video', enabled: true, videoName: 'loop.mp4' })
  })

  it('updates shared options without touching the selected source', () => {
    const video = writeVideo()
    pickVideoWallpaper(app, video)
    const updated = updateDynamicWallpaperPreferences(app, { focusX: 30, zoom: 150, blur: 4, panelOpacity: 70 })

    expect(updated.preferences).toMatchObject({
      kind: 'video',
      enabled: true,
      videoPath: video,
      focusX: 30,
      zoom: 150,
      blur: 4,
      panelOpacity: 70,
    })
    expect(updated.preferences.updatedAt).not.toBeNull()
  })

  it('picks a local video, enables it, and bumps the revision', () => {
    const video = writeVideo()
    const first = pickVideoWallpaper(app, video)
    expect(first?.preferences).toMatchObject({
      kind: 'video',
      enabled: true,
      videoPath: video,
      videoName: 'loop.mp4',
      revision: 1,
    })
    expect(first?.unavailable).toBeNull()

    expect(pickVideoWallpaper(app, writeVideo('second.webm'))?.preferences.revision).toBe(2)
  })

  it('refuses files that are not videos', () => {
    expect(pickVideoWallpaper(app, writeVideo('notes.txt'))).toBeNull()
    expect(pickVideoWallpaper(app, path.join(root, 'missing.mp4'))).toBeNull()
  })

  it('requires index.html before accepting a web pack', () => {
    const emptyDir = path.join(root, 'empty-pack')
    fs.mkdirSync(emptyDir)
    expect(pickWebWallpaper(app, emptyDir)).toMatchObject({
      error: 'web-index-missing',
      status: { preferences: { kind: 'image' } },
    })

    const pack = writePack()
    const result = pickWebWallpaper(app, pack)
    expect(result.error).toBeNull()
    expect(result.status.preferences).toMatchObject({
      kind: 'web',
      enabled: true,
      webDir: pack,
      webName: 'pack',
      revision: 1,
    })
  })

  it('does not call a kind missing before a source was chosen', () => {
    expect(resolveDynamicWallpaperStatus(app).unavailable).toBeNull()

    const video = updateDynamicWallpaperPreferences(app, { kind: 'video' })
    expect(video.preferences.kind).toBe('video')
    expect(video.unavailable).toBeNull()

    const web = updateDynamicWallpaperPreferences(app, { kind: 'web' })
    expect(web.unavailable).toBeNull()
  })

  it('reports a source that disappeared after it was picked', () => {
    const video = writeVideo()
    pickVideoWallpaper(app, video)
    fs.rmSync(video)
    expect(resolveDynamicWallpaperStatus(app).unavailable).toBe('video-missing')

    const pack = writePack()
    pickWebWallpaper(app, pack)
    fs.rmSync(path.join(pack, 'index.html'))
    expect(resolveDynamicWallpaperStatus(app).unavailable).toBe('web-missing')
  })

  it('clears only the active source and disables the wallpaper', () => {
    const video = writeVideo()
    pickVideoWallpaper(app, video)
    const cleared = clearDynamicWallpaperSource(app)

    expect(cleared.preferences).toMatchObject({
      kind: 'video',
      enabled: false,
      videoPath: null,
      videoName: null,
      revision: 2,
    })
  })

  it('bumps the revision on reload so the renderer refetches the pack', () => {
    pickWebWallpaper(app, writePack())
    expect(reloadDynamicWallpaper(app).preferences.revision).toBe(2)
  })
})