
/**
 * The few things more than one Settings panel needs.
 *
 * Extracted while splitting `Settings.tsx` into one module per panel, so a
 * panel never imports from the file that imports it. The hand-rolled checkbox
 * mark that used to live here is gone: settings toggles are `Switch` rows of
 * the shared skeleton (`components/settings/SettingsSection`), and dialog
 * checkboxes use `ui/Checkbox`.
 */

export function isValidHttpProxyUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
