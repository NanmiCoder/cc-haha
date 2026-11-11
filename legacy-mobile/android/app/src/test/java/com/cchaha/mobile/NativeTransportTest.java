package com.cchaha.mobile;
import org.junit.Test;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.URL;
import java.io.ByteArrayInputStream;
import java.security.cert.Certificate;
import javax.net.ssl.HttpsURLConnection;
import static org.junit.Assert.*;
public class NativeTransportTest {
  static class Connection extends HttpsURLConnection {
    int status = 200;
    Connection() throws Exception { super(new URL("https://fixture.test")); }
    public int getResponseCode() { return status; }
    public java.io.InputStream getInputStream() { return new ByteArrayInputStream("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
    public void disconnect() {} public boolean usingProxy() { return false; } public void connect() {}
    public String getCipherSuite() { return "TLS_FIXTURE"; }
    public Certificate[] getLocalCertificates() { return null; }
    public Certificate[] getServerCertificates() { return null; }
  }
  @Test public void neverFollowsRedirectsOrAcceptsAmbientCookieJar() throws Exception {
    Connection connection = new Connection(); connection.status = 302;
    NativeTransport transport = new NativeTransport.Https(url -> connection);
    assertThrows(IllegalArgumentException.class, () -> transport.request("https://fixture.test", "/challenge", null, null));
    assertFalse(connection.getInstanceFollowRedirects());
    CookieHandler previous = CookieHandler.getDefault();
    try {
      CookieHandler.setDefault(new CookieManager());
      assertThrows(IllegalStateException.class, () -> transport.request("https://fixture.test", "/challenge", null, null));
    } finally { CookieHandler.setDefault(previous); }
  }
  @Test public void anonymousRequestDoesNotAttachCookieAndRejectsHttpBeforeOpeningSocket() throws Exception {
    Connection connection = new Connection();
    NativeTransport transport = new NativeTransport.Https(url -> connection);
    assertEquals(200, transport.request("https://fixture.test", "/challenge", null, null).status);
    assertNull(connection.getRequestProperty("Cookie"));
    assertThrows(IllegalArgumentException.class, () -> transport.request("http://fixture.test", "/challenge", null, "must-not-send"));
  }
}
