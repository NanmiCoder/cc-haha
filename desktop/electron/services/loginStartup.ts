import type { DesktopLoginStartupStatus } from '../../src/lib/desktopHost/types'

type LoginOptions = { path?: string, args?: string[] }
type LoginApp = {
  isPackaged: boolean
  getPath(name: 'exe'): string
  getLoginItemSettings(options?: LoginOptions): { openAtLogin: boolean, status?: string, executableWillLaunchAtLogin?: boolean }
  setLoginItemSettings(options: LoginOptions & { openAtLogin: boolean }): void
}

/** Keep operating-system state separate from the user's remote-access intent. */
export class LoginStartupService {
  constructor(private readonly app: LoginApp, private readonly platform: string = process.platform) {}
  private get supported() { return this.app.isPackaged && (this.platform === 'darwin' || this.platform === 'win32') }
  private options(): LoginOptions | undefined { return this.platform === 'win32' ? { path: this.app.getPath('exe'), args: [] } : undefined }

  get(): DesktopLoginStartupStatus {
    const status = { supported: this.supported, enabled: false, requiresApproval: false }
    if (!status.supported) return status
    try {
      const actual = this.app.getLoginItemSettings(this.options())
      const enabled = this.platform === 'win32' ? actual.executableWillLaunchAtLogin ?? actual.openAtLogin : actual.openAtLogin
      return { ...status, enabled, requiresApproval: actual.status === 'requires-approval' }
    } catch { return { ...status, error: 'unavailable' } }
  }

  set(enabled: boolean): DesktopLoginStartupStatus {
    if (!this.supported) return this.get()
    try {
      this.app.setLoginItemSettings({ ...this.options(), openAtLogin: enabled })
      return this.get()
    } catch { return { ...this.get(), error: 'unavailable' } }
  }
}
