export function shouldUseManualWindowDrag(platform = typeof navigator === 'undefined' ? '' : navigator.platform) {
  void platform
  return false
}

export function useElectronWindowDragRegions() {
  // Electron's native app-region dragging is the supported frameless-window path.
  // The previous Windows JS delta fallback could resize frameless windows while moving them.
}
