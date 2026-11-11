package com.cchaha.mobile;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.Assume;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import static org.junit.Assert.*;

/** Opt-in disposable TLS fixture. No trusted CA, URL or test key enters the app APK. */
@RunWith(AndroidJUnit4.class)
@org.junit.FixMethodOrder(org.junit.runners.MethodSorters.NAME_ASCENDING)
public class NativeReconnectIntegrationTest {
  private final android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  private Context target() { return instrumentation.getTargetContext(); }
  private JSONObject config() throws Exception {
    java.io.InputStream stream;
    try { stream = instrumentation.getContext().getAssets().open("native-fixture-config.json"); }
    catch (java.io.IOException absent) { Assume.assumeTrue("Run with the disposable native TLS fixture assets", false); return null; }
    try (stream) { return new JSONObject(new String(stream.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8)); }
  }
  private NativeTransport transport() throws Exception {
    KeyStore ca = KeyStore.getInstance(KeyStore.getDefaultType()); ca.load(null);
    try (var stream = instrumentation.getContext().getAssets().open("native-fixture-ca.pem")) {
      ca.setCertificateEntry("fixture", CertificateFactory.getInstance("X.509").generateCertificate(stream));
    }
    TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); trust.init(ca);
    SSLContext tls = SSLContext.getInstance("TLS"); tls.init(null, trust.getTrustManagers(), null);
    return new NativeTransport.Https(url -> {
      javax.net.ssl.HttpsURLConnection connection = (javax.net.ssl.HttpsURLConnection) url.openConnection();
      connection.setSSLSocketFactory(tls.getSocketFactory());
      return connection; // Platform hostname verification remains enabled.
    });
  }
  private JSONObject control(NativeTransport transport, String path, JSONObject body) throws Exception {
    NativeTransport.Reply reply = transport.request(config().getString("directoryUrl"), "/test/" + path, body, null);
    assertEquals(200, reply.status); return reply.body;
  }
  private void cookie(JSONObject record, String value) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    instrumentation.runOnMainSync(() -> BrowserProfiles.cookiesNamed(ComputerRecords.profileName(record)).setCookie(record.optString("origin"), value, accepted -> {
      assertTrue(accepted); BrowserProfiles.cookiesNamed(ComputerRecords.profileName(record)).flush(); done.countDown();
    }));
    assertTrue(done.await(10, TimeUnit.SECONDS));
  }
  private String cookie(JSONObject record) {
    AtomicReference<String> value = new AtomicReference<>();
    instrumentation.runOnMainSync(() -> value.set(BrowserProfiles.cookiesNamed(ComputerRecords.profileName(record)).getCookie(record.optString("origin"))));
    return value.get();
  }
  private void save(ComputerRecords records) {
    assertTrue(target().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).edit().putString("data", records.serialize()).commit());
  }
  private String shell(String command) throws Exception {
    try (android.os.ParcelFileDescriptor descriptor = instrumentation.getUiAutomation().executeShellCommand(command);
         java.io.InputStream stream = new android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
      return new String(stream.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
    }
  }
  @Test public void aEnrollWithRealAndroidKeystoreAndRealDesktopApproval() throws Exception {
    JSONObject config = config(); NativeTransport transport = transport();
    JSONObject pairing = control(transport, "pairing", new JSONObject());
    RemoteUrl qr = RemoteUrl.parse(pairing.getString("origin") + "/remote#pair=" + pairing.getString("secret") + "&v=2&hostKey=" + config.getString("publicKey") + "&directory=" + config.getString("directoryUrl"));
    ComputerRecords records = new ComputerRecords("{}"); JSONObject record = records.add(qr, "TLS fixture");
    DeviceKeys keys = new DeviceKeys();
    ReconnectClient client = new ReconnectClient(transport, keys, System::currentTimeMillis);
    assertEquals(SessionProbe.State.UNPAIRED, client.connect(record, null).state);
    // Emulate H5's existing pair/claim flow against the actual desktop routes.
    NativeTransport.Reply pair = transport.request(qr.origin, "/api/public-access/pair", new JSONObject().put("secret", pairing.getString("secret")).put("name", "Android native test"), null);
    assertEquals(200, pair.status);
    control(transport, "approve-pending", new JSONObject());
    NativeTransport.Reply claim = transport.request(qr.origin, "/api/public-access/claim", pair.body, null);
    assertEquals(200, claim.status); assertEquals(1, claim.cookies.size());
    cookie(record, claim.cookies.get(0));
    ReconnectClient.Result result = client.connect(record, cookie(record));
    assertEquals(SessionProbe.State.ONLINE, result.state); assertNotNull(result.deviceId);
    records.connected(record, result); save(records);
    KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
    assertNull("Private key cannot be exported", store.getKey(record.getString("keyAlias"), null).getEncoded());
    assertEquals(config.getString("hostId"), record.getString("hostId"));
    assertFalse(records.serialize().contains(pairing.getString("secret")));
    assertFalse(records.serialize().contains("__Host-haha-remote"));
  }
  @Test public void bColdProcessRestoresAfterDesktopRestartNewOriginThenRevocationFailsClosed() throws Exception {
    config(); NativeTransport transport = transport();
    ComputerRecords records = new ComputerRecords(target().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).getString("data", "{}"));
    assertEquals("Run enrollment in a separate instrumentation process first", 1, records.computers().length());
    JSONObject record = records.computers().getJSONObject(0);
    String firstOrigin = record.getString("origin");
    DeviceKeys keys = new DeviceKeys();
    assertTrue(keys.exists(record.getString("keyAlias")));
    assertNotNull("HttpOnly cookie persisted across force-stop", cookie(record));
    ReconnectClient client = new ReconnectClient(transport, keys, System::currentTimeMillis);
    assertEquals(SessionProbe.State.ONLINE, client.connect(record, cookie(record)).state);
    control(transport, "switch-origin", new JSONObject().put("target", "B"));
    ReconnectClient.Result resumed = client.connect(record, cookie(record));
    assertEquals(SessionProbe.State.ONLINE, resumed.state);
    assertNotEquals(firstOrigin, resumed.origin); assertNotNull(resumed.cookie);
    records.connected(record, resumed); cookie(record, resumed.cookie); save(records);
    assertEquals(2, ComputerRecords.profiles(record).size());
    NativeTransport.Reply authenticated = transport.request(resumed.origin, "/api/public-access/session", null, cookie(record));
    assertTrue(authenticated.body.getBoolean("authenticated"));
    android.net.ConnectivityManager connectivity = target().getSystemService(android.net.ConnectivityManager.class);
    String mobileData = shell("settings get global mobile_data").trim();
    try {
      shell("svc wifi disable"); shell("svc data disable");
      long deadline = System.currentTimeMillis() + 10000;
      while (connectivity.getActiveNetwork() != null && System.currentTimeMillis() < deadline) Thread.sleep(100);
      assertNull("The emulator must actually lose its network", connectivity.getActiveNetwork());
      assertEquals(SessionProbe.State.OFFLINE, client.connect(record, cookie(record)).state);
    } finally {
      shell("svc wifi enable");
      if ("1".equals(mobileData)) shell("svc data enable");
    }
    long deadline = System.currentTimeMillis() + 15000;
    while (connectivity.getActiveNetwork() == null && System.currentTimeMillis() < deadline) Thread.sleep(100);
    assertNotNull(connectivity.getActiveNetwork());
    assertEquals(SessionProbe.State.ONLINE, client.connect(record, cookie(record)).state);
    control(transport, "revoke", new JSONObject().put("deviceId", record.getString("deviceId")));
    assertEquals(SessionProbe.State.PAIR_REQUIRED, client.connect(record, cookie(record)).state);
    keys.delete(record.getString("keyAlias"));
    assertFalse(keys.exists(record.getString("keyAlias")));
    for (String profile : ComputerRecords.profiles(record)) {
      CountDownLatch done = new CountDownLatch(1);
      instrumentation.runOnMainSync(() -> BrowserProfiles.clearNamed(profile, done::countDown));
      assertTrue(done.await(10, TimeUnit.SECONDS));
    }
    target().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).edit().clear().commit();
  }
}
