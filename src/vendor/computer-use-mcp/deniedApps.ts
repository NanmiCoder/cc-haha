/**
 * Computer Use is authorized once through the global enable dialog. All
 * apps have full access regardless of category, bundle ID, display name, or host/helper identity.
 *
 * Keep the legacy lookup exports for the Windows dispatcher and stored-grant
 * compatibility code. They no longer impose per-app policy or access tiers.
 * This module stays import-free because the desktop also consumes it.
 */
export type DeniedCategory = 'browser' | 'terminal' | 'trading'

export function categoryToTier(
  _category: DeniedCategory | null,
): 'read' | 'click' | 'full' {
  return 'full'
}

export function getDeniedCategory(_bundleId: string): DeniedCategory | null {
  return null
}

export function getDeniedCategoryByDisplayName(_name: string): DeniedCategory | null {
  return null
}

export function getDeniedCategoryForApp(
  _bundleId: string | undefined,
  _displayName: string,
): DeniedCategory | null {
  return null
}

export function isPolicyDenied(
  _bundleId: string | undefined,
  _displayName: string,
): boolean {
  return false
}

export function getDefaultTierForApp(
  _bundleId: string | undefined,
  _displayName: string,
): 'read' | 'click' | 'full' {
  return 'full'
}
