package com.cchaha.mobile;

import org.junit.Test;
import static org.junit.Assert.*;
import static com.cchaha.mobile.NavigationPolicy.Decision.*;

public class NavigationPolicyTest {
  private final String origin = "https://computer.test";
  @Test public void spaBackHandledByThePageDoesNotNavigateTheNativeShell() {
    assertEquals(NavigationPolicy.BackAction.HANDLED, NavigationPolicy.backAction("true", true));
    assertEquals(NavigationPolicy.BackAction.HANDLED, NavigationPolicy.backAction("true", false));
  }
  @Test public void spaRootBackBackgroundsEvenWithOldWebViewHistory() {
    assertEquals(NavigationPolicy.BackAction.BACKGROUND, NavigationPolicy.backAction("false", true));
    assertEquals(NavigationPolicy.BackAction.BACKGROUND, NavigationPolicy.backAction("false", false));
  }
  @Test public void olderPagesAndUnresponsiveBridgesFallBackToHistoryOrBackground() {
    for (String missing : new String[] { null, "null", "undefined", "\"true\"", "{}" }) {
      assertEquals(NavigationPolicy.BackAction.HISTORY, NavigationPolicy.backAction(missing, true));
      assertEquals(NavigationPolicy.BackAction.BACKGROUND, NavigationPolicy.backAction(missing, false));
    }
  }
  @Test public void trustedSameOriginNavigationWorks() {
    assertEquals(INTERNAL, NavigationPolicy.decide(origin, origin + "/remote/session", true));
    assertEquals(INTERNAL, NavigationPolicy.decide(origin, origin + ":443/remote", true));
  }
  @Test public void crossOriginAndPortsLeaveTheAuthenticatedWebview() {
    assertEquals(EXTERNAL, NavigationPolicy.decide(origin, "https://docs.example.test/guide", true));
    assertEquals(EXTERNAL, NavigationPolicy.decide(origin, origin + ":8443/remote", true));
    assertEquals(BLOCK, NavigationPolicy.decide(origin, "https://docs.example.test/frame", false));
  }
  @Test public void unsafeSchemesAndPairingExfiltrationAreBlocked() {
    for (String url : new String[] { "file:///etc/passwd", "content://secret", "http://computer.test/remote", "intent://x", "javascript:alert(1)", "https://evil.test/#pair=secret" }) {
      assertEquals(BLOCK, NavigationPolicy.decide(origin, url, true));
    }
  }
}
