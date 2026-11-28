import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SDKControlRequestSchema,
  SDKFastModeStatusMessageSchema,
  StdoutMessageSchema,
} from '../../entrypoints/sdk/controlSchemas.js'
import { conversationService } from '../services/conversationService.js'
import { handleSettingsApi } from './settings.js'

describe('settings API fastMode persistence and live sync', () => {
  let tempDir: string
  let savedConfigDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-settings-fastmode-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('persists fastMode=true, deletes on null, and syncs active sessions', async () => {
    const syncSpy = spyOn(conversationService, 'setFastModeForActiveSessions').mockReturnValue(1)
    try {
      const putOn = await handleSettingsApi(
        new Request('http://localhost/api/settings/user', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fastMode: true }),
        }),
        new URL('http://localhost/api/settings/user'),
        ['api', 'settings', 'user'],
      )
      expect(putOn.status).toBe(200)
      expect(syncSpy).toHaveBeenLastCalledWith(true)

      const onDisk = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf8'))
      expect(onDisk.fastMode).toBe(true)

      const getRes = await handleSettingsApi(
        new Request('http://localhost/api/settings/user', { method: 'GET' }),
        new URL('http://localhost/api/settings/user'),
        ['api', 'settings', 'user'],
      )
      expect((await getRes.json()).fastMode).toBe(true)

      const putOff = await handleSettingsApi(
        new Request('http://localhost/api/settings/user', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fastMode: null }),
        }),
        new URL('http://localhost/api/settings/user'),
        ['api', 'settings', 'user'],
      )
      expect(putOff.status).toBe(200)
      expect(syncSpy).toHaveBeenLastCalledWith(false)

      const afterClear = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf8'))
      expect(afterClear.fastMode).toBeUndefined()
    } finally {
      syncSpy.mockRestore()
    }
  })

  test('rejects non-boolean fastMode payload with 400', async () => {
    const res = await handleSettingsApi(
      new Request('http://localhost/api/settings/user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastMode: 'yes' }),
      }),
      new URL('http://localhost/api/settings/user'),
      ['api', 'settings', 'user'],
    )
    expect(res.status).toBe(400)
  })

  test('SDK control schema accepts set_fast_mode request and fast_mode_status system event', () => {
    const parsed = SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'set_fast_mode',
        enabled: true,
      },
    })
    expect(parsed.success).toBe(true)

    const statusPayload = {
      type: 'system',
      subtype: 'fast_mode_status',
      fast_mode_state: 'off',
      reason: 'org_disabled',
      message: 'Fast mode has been disabled by your organization',
      session_id: 'sess-1',
      uuid: '00000000-0000-4000-8000-000000000001',
    }
    expect(SDKFastModeStatusMessageSchema().safeParse(statusPayload).success).toBe(true)
    expect(StdoutMessageSchema().safeParse(statusPayload).success).toBe(true)
  })
})
