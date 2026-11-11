package com.cchaha.mobile;

import org.junit.Test;
import static org.junit.Assert.*;
import static com.cchaha.mobile.BrowserRecoveryPolicy.*;

public class BrowserRecoveryPolicyTest {
  @Test public void appSwitchReusesLoadedPageAndOnlyMissingPageNeedsVerification() {
    assertEquals(Resume.REUSE, resume(true, false));
    assertEquals(Resume.REUSE, resume(true, true));
    assertEquals(Resume.REVERIFY, resume(false, true));
    assertEquals(Resume.REFRESH, resume(false, false));
  }

  @Test public void initialAndDuplicateNetworkCallbacksKeepExistingPageAcrossAppSwitch() {
    String wifi = "wifi";
    assertEquals(Availability.KEEP, available(null, wifi, true, true));
    assertEquals(Availability.KEEP, available(wifi, new String("wifi"), true, true));
    assertEquals(Availability.KEEP, available(wifi, wifi, true, false));
    assertEquals(Resume.REUSE, resume(true, false));
    assertEquals(Availability.KEEP, available(wifi, wifi, true, true));
  }

  @Test public void networkSwitchInvalidatesTrustButLateOldNetworkLossCannotCloseReplacement() {
    assertEquals(Availability.INVALIDATE, available("wifi", "cellular", true, true));
    assertEquals(Availability.INVALIDATE, available("wifi", "cellular", true, false));
    assertFalse(lostCurrentNetwork("cellular", "wifi"));
    assertTrue(lostCurrentNetwork("cellular", "cellular"));
    assertFalse(lostCurrentNetwork(null, "cellular"));
    assertEquals(Availability.REVERIFY, available(null, "wifi", false, true));
    assertEquals(Availability.KEEP, available(null, "wifi", false, false));
    assertEquals(Resume.REVERIFY, resume(false, true));
  }

  @Test public void healthyOrRenewedSameOriginSessionKeepsDocumentAndVerifiedRotationReplacesIt() {
    assertFalse(replaceDocument("host", "https://a.test", "host", "https://a.test"));
    assertTrue(replaceDocument("host", "https://a.test", "host", "https://b.test"));
    assertFalse(replaceDocument("host", "https://a.test", "other-host", "https://b.test"));
    assertFalse(replaceDocument(null, null, "host", "https://a.test"));
  }
}
