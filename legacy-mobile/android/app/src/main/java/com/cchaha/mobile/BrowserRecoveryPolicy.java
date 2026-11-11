package com.cchaha.mobile;

/** Decisions that do not depend on Android callbacks or a running renderer. */
final class BrowserRecoveryPolicy {
  enum Resume { REUSE, REVERIFY, REFRESH }
  enum Availability { KEEP, REVERIFY, INVALIDATE }

  static Resume resume(boolean hasBrowser, boolean restoringComputer) {
    if (hasBrowser) return Resume.REUSE;
    return restoringComputer ? Resume.REVERIFY : Resume.REFRESH;
  }

  static Availability available(Object previousNetwork, Object network, boolean hasBrowser, boolean resumed) {
    if (previousNetwork != null && !previousNetwork.equals(network)) return Availability.INVALIDATE;
    return !hasBrowser && resumed ? Availability.REVERIFY : Availability.KEEP;
  }

  static boolean lostCurrentNetwork(Object currentNetwork, Object lostNetwork) {
    return currentNetwork != null && currentNetwork.equals(lostNetwork);
  }

  static boolean replaceDocument(String activeId, String activeOrigin, String resultId, String resultOrigin) {
    // Fresh authentication cookies at the same origin are applied in place.
    return resultId.equals(activeId) && !resultOrigin.equals(activeOrigin);
  }
}
