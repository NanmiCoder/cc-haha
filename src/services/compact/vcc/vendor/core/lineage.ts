// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
export interface LineageEntryLike {
  id?: string;
}

export interface LineageSessionManagerLike {
  getBranch: () => LineageEntryLike[];
  getEntries?: () => LineageEntryLike[];
}

export const getActiveLineageEntryIds = (sessionManager: LineageSessionManagerLike): Set<string> => {
  try {
    const branch = sessionManager.getBranch() ?? [];
    if (branch.length > 0) {
      return new Set(branch.map((e) => e.id).filter((id): id is string => Boolean(id)));
    }
  } catch {
    // fall through to defensive fallback
  }

  try {
    const all = sessionManager.getEntries?.() ?? [];
    return new Set(all.map((e) => e.id).filter((id): id is string => Boolean(id)));
  } catch {
    return new Set();
  }
};
