package com.cchaha.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteUrlTest {
  @Test public void qrNormalizesOriginAndDoesNotSaveSecret() {
    RemoteUrl url = RemoteUrl.parse("https://My-Computer.trycloudflare.com:443/remote#pair=abcDEF0123456789_-abcdef");
    assertEquals("https://my-computer.trycloudflare.com", url.origin);
    assertEquals("https://my-computer.trycloudflare.com/remote", url.savedUrl());
    assertTrue(url.pairing);
    assertTrue(url.isTemporaryTunnel());
    assertTrue(url.launchUrl.contains("#pair="));
  }

  @Test public void acceptsSavedLinksAndExplicitTlsPorts() {
    assertFalse(RemoteUrl.parse("https://example.test/remote/").pairing);
    assertEquals("https://example.test:8443", RemoteUrl.parse("https://example.test:8443/remote").origin);
    assertEquals("https://[::1]:8443", RemoteUrl.parse("https://[::1]:8443/remote").origin);
  }

  @Test public void rejectsUnsafeOrAmbiguousQrContents() {
    String[] invalid = {
      "http://example.test/remote", "javascript:alert(1)", "file:///remote", "content://remote",
      "https://user:pass@example.test/remote", "https://example.test@evil.test/remote",
      "https://example.test/remote?token=secret", "https://example.test/remote#pair=short",
      "https://example.test/remote#pair=abcdefghijklmnop&other=x", "https://example.test/%72emote",
      "https://example.test/remote/../admin", "https://example.test/", "https://example.test:0/remote",
      "https://example.test:65536/remote", "https://example.test./remote", "https://example.test\\@evil.test/remote",
      "https://exa\nmple.test/remote", "https://example.test/remote#pair=abc%2F123456789012345"
    };
    for (String value : invalid) {
      try { RemoteUrl.parse(value); fail("Accepted unsafe input"); }
      catch (IllegalArgumentException expected) { assertFalse(expected.getMessage().contains("secret")); }
    }
  }
}
