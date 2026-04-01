declare const MACRO: {
  VERSION: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  BUILD_TIME: string
  FEEDBACK_CHANNEL: string
  VERSION_CHANGELOG: string
  ISSUES_EXPLAINER: string
}

declare module 'bun:bundle' {
  export function feature(name: string): boolean
}