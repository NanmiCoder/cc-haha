package com.cchaha.mobile;

import org.junit.Test;
import org.json.JSONObject;
import org.json.JSONArray;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class RemoteProtocolTest {
  @Test public void everyBunVectorVerifiesAndJavaSignsIdenticalBytes() throws Exception {
    ProtocolFixture fixture = new ProtocolFixture();
    assertEquals(fixture.hostId, RemoteProtocol.hostId(fixture.publicKey));
    JSONArray examples = fixture.data.getJSONArray("examples");
    assertEquals(6, examples.length());
    for (int i = 0; i < examples.length(); i++) {
      JSONObject example = examples.getJSONObject(i);
      JSONArray input = example.getJSONArray("fields");
      String[] fields = new String[input.length()];
      for (int j = 0; j < fields.length; j++) fields[j] = input.getString(j);
      String purpose = example.getString("purpose"), signature = example.getString("signature");
      assertEquals(example.getString("canonical"), new String(RemoteProtocol.canonical(purpose, fields), StandardCharsets.UTF_8));
      RemoteProtocol.verify(fixture.publicKey, signature, purpose, fields);
      assertEquals(signature, fixture.signed(purpose, fields));
      assertThrows(IllegalArgumentException.class, () -> RemoteProtocol.verify(fixture.publicKey, signature, "wrong-purpose", fields));
    }
  }
  @Test public void rejectsAmbiguousEncodingAndCanonicalSeparators() {
    assertThrows(IllegalArgumentException.class, () -> RemoteProtocol.decode("AA=="));
    assertThrows(IllegalArgumentException.class, () -> RemoteProtocol.decode("AB"));
    assertThrows(IllegalArgumentException.class, () -> RemoteProtocol.canonical("resume", "one\ntwo"));
    assertThrows(IllegalArgumentException.class, () -> RemoteProtocol.canonical("resume", "one\rtwo"));
    assertFalse(RemoteProtocol.isNonce("abcdefghijklmnop"));
    assertTrue(RemoteProtocol.isNonce(RemoteProtocol.nonce()));
  }
  @Test public void qrPinsIdentityAndNeverPassesDirectoryOrKeyIntoH5() throws Exception {
    ProtocolFixture fixture = new ProtocolFixture();
    RemoteUrl url = RemoteUrl.parse(fixture.qr("https://a.test"));
    assertEquals(fixture.hostId, url.hostId);
    assertEquals("https://directory.test", url.directory);
    assertEquals("https://a.test/remote#pair=abcdefghijklmnop", url.launchUrl);
    assertThrows(IllegalArgumentException.class, () -> RemoteUrl.parse(fixture.qr("https://a.test") + "&v=2"));
    assertThrows(IllegalArgumentException.class, () -> RemoteUrl.parse(fixture.qr("https://a.test").replace("&v=2", "&v=3")));
    assertThrows(IllegalArgumentException.class, () -> RemoteUrl.parse(fixture.qr("https://a.test").replace("https%3A%2F%2Fdirectory.test", "http%3A%2F%2Fdirectory.test")));
  }
}
