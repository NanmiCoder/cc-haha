// Android APK 随每个桌面端正式版挂在 GitHub Release 上（scripts/mobile-release.ts）。
// iOS 走 TestFlight 外部测试「公开测试」组的公开链接；置为 null 时界面回到「待开放」。
export const mobileAppLinks: { android: string, testFlight: string | null } = {
  android: 'https://github.com/NanmiCoder/cc-haha/releases/latest',
  testFlight: 'https://testflight.apple.com/join/Nd49JrWZ',
}
