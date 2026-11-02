/**
 * 首屏主下载按钮按访客的系统显示对应桌面版。手机、平板（包括 UA 伪装成 Mac 的 iPadOS）
 * 和 ChromeOS 没有可直接安装的桌面包，返回 null，由调用方显示通用的「下载桌面端」。
 */
export function detectDesktopPlatform({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/Android|iOS|iPhone|iPad|iPod|Chrome OS|CrOS/i.test(platform)) return null
  if (/Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(userAgent)) return null
  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/.test(userAgent)) {
    return maxTouchPoints > 1 ? null : 'macOS'
  }
  if (/Win/i.test(platform) || /Windows/.test(userAgent)) return 'Windows'
  if (/Linux/i.test(platform) || /Linux|X11/.test(userAgent)) return 'Linux'
  return null
}

export function currentDesktopPlatform() {
  if (typeof navigator === 'undefined') return null
  return detectDesktopPlatform({
    userAgent: navigator.userAgent || '',
    platform: navigator.userAgentData?.platform || navigator.platform || '',
    maxTouchPoints: navigator.maxTouchPoints || 0
  })
}
