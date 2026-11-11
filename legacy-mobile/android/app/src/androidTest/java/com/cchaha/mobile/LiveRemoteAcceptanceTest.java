package com.cchaha.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Explicitly opt-in public HTTPS acceptance on a disposable emulator. No embedded endpoint or CA. */
@RunWith(AndroidJUnit4.class)
public class LiveRemoteAcceptanceTest {
  private static final String CONFIG = "live-remote-acceptance.json";
  private static final String MARKER = "live_remote_acceptance";
  private final android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  private final NativeTransport transport = new NativeTransport.Https();
  private Context target() { return instrumentation.getTargetContext(); }
  private SharedPreferences marker() { return target().getSharedPreferences(MARKER, Context.MODE_PRIVATE); }
  private JSONObject config() throws Exception {
    Assume.assumeTrue("Opt-in live acceptance requires a disposable emulator",
        "disposable-emulator".equals(InstrumentationRegistry.getArguments().getString("liveRemoteAcceptance")));
    try (var stream = target().openFileInput(CONFIG)) {
      byte[] bytes = stream.readNBytes(65537);
      assertTrue("Runtime config is bounded", bytes.length <= 65536);
      return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }
  }
  private ComputerRecords records() throws Exception {
    return new ComputerRecords(target().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).getString("data", "{}"));
  }
  private JSONObject boundRecord(ComputerRecords records) throws Exception {
    assertEquals("Use the same isolated emulator state from enrollment", 1, records.computers().length());
    JSONObject record = records.computers().getJSONObject(0);
    assertTrue(ComputerRecords.isBound(record));
    assertEquals(marker().getString("hostId", "missing"), record.getString("hostId"));
    assertEquals(marker().getString("deviceId", "missing"), record.getString("deviceId"));
    return record;
  }
  private void save(ComputerRecords records) {
    assertTrue(target().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).edit().putString("data", records.serialize()).commit());
  }
  private String cookie(JSONObject record) {
    AtomicReference<String> value = new AtomicReference<>();
    instrumentation.runOnMainSync(() -> value.set(BrowserProfiles.cookiesNamed(ComputerRecords.profileName(record)).getCookie(record.optString("origin"))));
    return value.get();
  }
  private void cookie(JSONObject record, String value) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<Boolean> accepted = new AtomicReference<>(false);
    instrumentation.runOnMainSync(() -> BrowserProfiles.cookiesNamed(ComputerRecords.profileName(record)).setCookie(record.optString("origin"), value, success -> {
      accepted.set(success);
      BrowserProfiles.cookiesNamed(ComputerRecords.profileName(record)).flush();
      done.countDown();
    }));
    assertTrue(done.await(10, TimeUnit.SECONDS));
    assertTrue("Verified authentication cookie was accepted", accepted.get());
  }
  private ReconnectClient client() { return new ReconnectClient(transport, new DeviceKeys(), System::currentTimeMillis); }
  private void persistResult(ComputerRecords records, JSONObject record, ReconnectClient.Result result) throws Exception {
    assertEquals(SessionProbe.State.ONLINE, result.state);
    assertEquals(marker().getString("deviceId", "missing"), result.deviceId);
    records.connected(record, result);
    if (result.cookie != null) cookie(record, result.cookie);
    save(records);
  }

  @Test public void enroll() throws Exception {
    JSONObject config = config();
    ComputerRecords records = records();
    assertEquals("Never replace an existing user's paired computers", 0, records.computers().length());
    assertFalse("Clean up a previous run before enrollment", marker().contains("hostId"));
    RemoteUrl qr = RemoteUrl.parse(config.getString("pairingUrl"));
    assertNotNull("A v2 QR must pin the host identity", qr.hostId);
    JSONObject record = records.add(qr, "Private remote acceptance");
    ReconnectClient client = client();
    assertEquals(SessionProbe.State.UNPAIRED, client.connect(record, null).state);
    // Request approval through production routes. The desktop-side runner approves locally.
    String secret = android.net.Uri.parse("https://unused.invalid/?" + android.net.Uri.parse(qr.launchUrl).getEncodedFragment()).getQueryParameter("pair");
    assertNotNull(secret);
    NativeTransport.Reply pair = transport.request(qr.origin, "/api/public-access/pair",
        new JSONObject().put("secret", secret).put("name", "Android private acceptance"), null);
    assertEquals(200, pair.status);
    NativeTransport.Reply claim = null;
    long deadline = System.currentTimeMillis() + 90000;
    while (System.currentTimeMillis() < deadline) {
      claim = transport.request(qr.origin, "/api/public-access/claim", pair.body, null);
      assertEquals("The desktop pairing request must remain valid", 200, claim.status);
      if ("approved".equals(claim.body.optString("status"))) break;
      assertEquals("pending", claim.body.optString("status"));
      Thread.sleep(1000);
    }
    assertNotNull(claim);
    assertEquals("Approve the pending request in the isolated desktop backend", "approved", claim.body.optString("status"));
    assertEquals(1, claim.cookies.size());
    cookie(record, claim.cookies.get(0));
    ReconnectClient.Result result = client.connect(record, cookie(record));
    assertEquals(SessionProbe.State.ONLINE, result.state);
    assertNotNull(result.deviceId);
    records.connected(record, result);
    save(records);
    assertTrue(marker().edit().putString("hostId", record.getString("hostId"))
        .putString("deviceId", result.deviceId).putString("firstOrigin", result.origin).commit());
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    assertNull("Device private key stays in AndroidKeyStore", keys.getKey(record.getString("keyAlias"), null).getEncoded());
    assertFalse(records.serialize().contains(secret));
    assertFalse(records.serialize().contains("__Host-haha-remote"));
    // Erase the one-use QR immediately; later phases receive a new non-secret runtime config.
    assertTrue(target().deleteFile(CONFIG));
  }

  @Test public void resumeAfterForceStop() throws Exception {
    config();
    ComputerRecords records = records(); JSONObject record = boundRecord(records);
    assertTrue(new DeviceKeys().exists(record.getString("keyAlias")));
    assertNotNull("Cookie persisted across a separate app process", cookie(record));
    persistResult(records, record, client().connect(record, cookie(record)));
  }

  @Test public void discoverRotatedOrigin() throws Exception {
    JSONObject config = config();
    String expected = RemoteUrl.requireOrigin(config.getString("expectedOrigin"));
    ComputerRecords records = records(); JSONObject record = boundRecord(records);
    String oldOrigin = record.getString("origin");
    assertNotEquals("Stop the old tunnel and publish a newly allocated address first", oldOrigin, expected);
    ReconnectClient.Result result = client().connect(record, cookie(record));
    assertEquals(SessionProbe.State.ONLINE, result.state);
    assertEquals("The signed deployed directory must locate the replacement tunnel", expected, result.origin);
    assertTrue("Discovery must advance the signed sequence", result.sequence > record.optLong("sequence", 0));
    assertNotNull("A changed origin requires a fresh signed session cookie", result.cookie);
    persistResult(records, record, result);
    assertTrue(ComputerRecords.profiles(record).size() >= 2);
    NativeTransport.Reply session = transport.request(result.origin, "/api/public-access/session", null, cookie(record));
    assertEquals(200, session.status);
    assertTrue(session.body.getBoolean("authenticated"));
  }

  @Test public void offlineThenOnline() throws Exception {
    config();
    Assume.assumeTrue("Network toggling is separately opt-in", "yes".equals(InstrumentationRegistry.getArguments().getString("liveRemoteNetworkToggle")));
    ComputerRecords records = records(); JSONObject record = boundRecord(records);
    ConnectivityManager connectivity = target().getSystemService(ConnectivityManager.class);
    assertNotNull("Start with a working emulator network", connectivity.getActiveNetwork());
    String wifi = shell("settings get global wifi_on").trim();
    String data = shell("settings get global mobile_data").trim();
    try {
      shell("svc wifi disable"); shell("svc data disable");
      long deadline = System.currentTimeMillis() + 10000;
      while (connectivity.getActiveNetwork() != null && System.currentTimeMillis() < deadline) Thread.sleep(100);
      assertNull("The emulator really lost its network", connectivity.getActiveNetwork());
      assertEquals(SessionProbe.State.OFFLINE, client().connect(record, cookie(record)).state);
    } finally {
      if ("1".equals(wifi)) shell("svc wifi enable");
      if ("1".equals(data)) shell("svc data enable");
    }
    long deadline = System.currentTimeMillis() + 20000;
    while (connectivity.getActiveNetwork() == null && System.currentTimeMillis() < deadline) Thread.sleep(100);
    assertNotNull("Restore the original emulator network", connectivity.getActiveNetwork());
    persistResult(records, record, client().connect(record, cookie(record)));
  }

  @Test public void realWebViewLoadsAuthenticatedH5() throws Exception {
    config(); boundRecord(records());
    AtomicReference<WebView> web = new AtomicReference<>();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        View button = find(activity.findViewById(android.R.id.content), view -> view instanceof Button && ((Button) view).getText().toString().equals(activity.getString(R.string.connect)));
        assertNotNull("Saved computer has a Connect button", button);
        button.performClick();
      });
      long deadline = System.currentTimeMillis() + 90000;
      while (System.currentTimeMillis() < deadline) {
        scenario.onActivity(activity -> web.set((WebView) find(activity.findViewById(android.R.id.content), view -> view instanceof WebView)));
        if (web.get() != null && "true".equals(evaluate(web.get(), "!!(window.__ccHahaMobileState && typeof window.__ccHahaMobileState.capture === 'function') && !document.querySelector('[aria-busy=\"true\"]')"))) {
          CountDownLatch frame = new CountDownLatch(1);
          instrumentation.runOnMainSync(() -> web.get().postVisualStateCallback(1, new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) { web.get().postDelayed(frame::countDown, 250); }
          }));
          assertTrue("WebView presents its authenticated page", frame.await(10, TimeUnit.SECONDS));
          java.io.File directory = target().getExternalFilesDir("live-acceptance");
          assertNotNull(directory);
          android.graphics.Bitmap screenshot = instrumentation.getUiAutomation().takeScreenshot();
          assertNotNull(screenshot);
          try (var stream = new java.io.FileOutputStream(new java.io.File(directory, "webview.png"))) {
            assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream));
          } finally { screenshot.recycle(); }
          return;
        }
        Thread.sleep(250);
      }
      fail("Production H5 did not finish loading its authenticated mobile state bridge and session list");
    }
  }

  @Test public void revokedDeviceRequiresPairing() throws Exception {
    config();
    ComputerRecords records = records(); JSONObject record = boundRecord(records);
    assertEquals("Revoke the enrolled Android device on the desktop before this phase", SessionProbe.State.PAIR_REQUIRED,
        client().connect(record, cookie(record)).state);
  }

  @Test public void cleanup() throws Exception {
    config();
    ComputerRecords records = records(); JSONObject record = boundRecord(records);
    DeviceKeys keys = new DeviceKeys(); keys.delete(record.getString("keyAlias"));
    assertFalse(keys.exists(record.getString("keyAlias")));
    for (String profile : ComputerRecords.profiles(record)) {
      CountDownLatch done = new CountDownLatch(1);
      instrumentation.runOnMainSync(() -> BrowserProfiles.clearNamed(profile, done::countDown));
      assertTrue(done.await(10, TimeUnit.SECONDS));
    }
    records.remove(record.getString("hostId")); save(records);
    assertTrue(marker().edit().clear().commit());
    assertTrue(target().deleteFile(CONFIG));
  }

  private String shell(String command) throws Exception {
    try (android.os.ParcelFileDescriptor descriptor = instrumentation.getUiAutomation().executeShellCommand(command);
         var stream = new android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
      return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
    }
  }
  private static View find(View view, java.util.function.Predicate<View> predicate) {
    if (predicate.test(view)) return view;
    if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
      View found = find(((ViewGroup) view).getChildAt(i), predicate);
      if (found != null) return found;
    }
    return null;
  }
  private String evaluate(WebView web, String script) throws Exception {
    AtomicReference<String> value = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
    instrumentation.runOnMainSync(() -> web.evaluateJavascript(script, result -> { value.set(result); done.countDown(); }));
    assertTrue(done.await(10, TimeUnit.SECONDS));
    return value.get();
  }
}
