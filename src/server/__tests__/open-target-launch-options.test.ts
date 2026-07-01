import { describe, expect, it } from 'bun:test'
import { getDefaultLaunchSpawnOptions } from '../services/openTargetService.js'

describe('getDefaultLaunchSpawnOptions', () => {
  it('detaches the child process so VS Code/Cursor outlive cc-haha', () => {
    expect(getDefaultLaunchSpawnOptions().detached).toBe(true)
  })

  it("ignores stdio so it can't keep the parent alive on graceful exit", () => {
    expect(getDefaultLaunchSpawnOptions().stdio).toBe('ignore')
  })

  // Regression guard for the "VS Code starts but no window appears" bug:
  // setting windowsHide: true forwards SW_HIDE as the initial nCmdShow to
  // GUI-subsystem .exe targets, which Windows then applies to the app's
  // first ShowWindow() call — keeping the main window hidden even though
  // the process is fully running. See the docblock on the helper.
  it('does NOT set windowsHide (would hide the GUI window on Windows)', () => {
    const options = getDefaultLaunchSpawnOptions() as Record<string, unknown>
    expect(options.windowsHide).toBeUndefined()
  })

  it('does not pass any extra fields that could change spawn semantics', () => {
    const options = getDefaultLaunchSpawnOptions()
    expect(Object.keys(options).sort()).toEqual(['detached', 'stdio'])
  })
})
