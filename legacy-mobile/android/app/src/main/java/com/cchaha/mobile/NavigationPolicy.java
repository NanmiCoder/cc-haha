package com.cchaha.mobile;

/** External pages never inherit the embedded authenticated browser. */
public final class NavigationPolicy {
  public enum Decision { INTERNAL, EXTERNAL, BLOCK }
  public enum BackAction { HANDLED, HISTORY, BACKGROUND }

  public static BackAction backAction(String bridgeResult, boolean hasHistory) {
    if ("true".equals(bridgeResult)) return BackAction.HANDLED;
    // A present SPA bridge owns its navigation stack, even if WebView has stale
    // URL history. Root-level Back backgrounds the app; switching hosts is explicit.
    if ("false".equals(bridgeResult)) return BackAction.BACKGROUND;
    return hasHistory ? BackAction.HISTORY : BackAction.BACKGROUND;
  }

  public static Decision decide(String trustedOrigin, String target, boolean mainFrame) {
    try {
      var uri = RemoteUrl.secureUri(target);
      if (trustedOrigin.equals(RemoteUrl.originOf(uri))) return Decision.INTERNAL;
      // A pairing link must never leak its secret to another app or origin.
      if (uri.getRawFragment() != null && uri.getRawFragment().contains("pair=")) return Decision.BLOCK;
      return mainFrame ? Decision.EXTERNAL : Decision.BLOCK;
    } catch (Exception error) {
      return Decision.BLOCK;
    }
  }
}
