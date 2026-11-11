package com.cchaha.mobile;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.graphics.Bitmap;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Real Android views/WebView, all host responses supplied in-process. No network or account. */
@RunWith(AndroidJUnit4.class)
public class MobileSmokeTest {
  private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  private final AtomicReference<WebView> web = new AtomicReference<>();
  private final java.util.concurrent.atomic.AtomicBoolean holdCapture = new java.util.concurrent.atomic.AtomicBoolean();
  private final AtomicReference<android.webkit.ValueCallback<String>> delayedCapture = new AtomicReference<>();
  private final java.util.concurrent.atomic.AtomicBoolean holdBackProbe = new java.util.concurrent.atomic.AtomicBoolean();
  private final AtomicReference<android.webkit.ValueCallback<String>> delayedBackProbe = new AtomicReference<>();
  private final AtomicReference<String> endpoint = new AtomicReference<>(ORIGIN);
  private final java.util.concurrent.atomic.AtomicInteger backgroundRequests = new java.util.concurrent.atomic.AtomicInteger();
  private final java.util.concurrent.atomic.AtomicInteger documentLoads = new java.util.concurrent.atomic.AtomicInteger();
  private static final String ORIGIN = "https://mobile-fixture.invalid";
  private static final String KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1H5LTpfa1L8qNJzeJq87_PInTAToWYhuF2AvMuuE2PUrs24yobDdZB9hNTVov4C1TjCQ2vSoLO-CQY2YEcdfZa6Koo3RUuMi90fjfrZ1nIBgJNc3eaQQqtf2iwIpPA7860eA3NIfhknMvEBSU_rVAgZdNI7q4Bd8KbZgc4bJQrILq5uLCjcBp0xV3uks4mJXoJhRqooC89aIz_8x-MepaDUkNBYHzkykrHsIfxGuAe0iBZnoD7jh0VEEiI9dsfe8SmcLLT9_QZHrT6A_EcrcsjsYuIBp7Tv9jhLGSpmL_hymMmCZJ9naDUtfIOQ9cUidVj4QfJZONQ54gQvzYYQKBwIDAQAB";
  private static final String HOST_ID = RemoteProtocol.hostId(KEY);
  private static String profile(String origin) { return BrowserProfiles.key(HOST_ID, origin); }
  private static String qr() { return ORIGIN + "/remote#pair=abcdefghijklmnop&v=2&hostKey=" + KEY + "&directory=https%3A%2F%2Fdirectory-fixture.invalid"; }
  private static final String HTML = "<!doctype html><meta name='viewport' content='width=device-width'><title>Fixture</title>"
      + "<h1>Desktop session</h1><div id='output'>Working</div><button id='approval' onclick=\"document.querySelector('#output').textContent='Approved · Completed'\">Approve</button>"
      + "<input id='file' type='file' onchange=\"this.files[0].text().then(t=>document.querySelector('#upload').textContent=t).catch(e=>document.querySelector('#upload').textContent=e.message)\"><div id='upload'></div>"
      + "<input id='draft'><script>window.selectedSession='fixture-session';window.__ccHahaMobileState={capture:()=>({version:1,sessionId:window.selectedSession,drafts:[{sessionId:window.selectedSession,text:document.querySelector('#draft').value}],cookie:'never-copy'}),restore:s=>{window.selectedSession=s.sessionId;document.querySelector('#draft').value=s.drafts[0]?.text??'';return true}};</script>"
      + "<script>window.backStack=['chat'];window.__CC_HAHA_MOBILE_NAVIGATE_BACK__=()=>{if(window.backStack.length>1){window.backStack.pop();return true}return false};window.resumeCount=0;window.addEventListener('cc-haha:resume',()=>window.resumeCount++);window.focusCount=0;window.addEventListener('focus',()=>window.focusCount++);setTimeout(()=>document.querySelector('#output').textContent='Live output from computer',100)</script>";

  @Before public void setup() {
    Context context = instrumentation.getTargetContext();
    context.getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).edit().clear().commit();
    MainActivity.backgroundTask = activity -> backgroundRequests.incrementAndGet();
    MainActivity.temporaryProbe = (origin, cookie) -> new SessionProbe.Result(SessionProbe.State.UNPAIRED, "Temporary fixture");
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(cookie != null && cookie.contains("fixture-token") ? SessionProbe.State.ONLINE : SessionProbe.State.UNPAIRED, endpoint.get(), endpoint.get().equals(ORIGIN) ? 1 : 2, null, null, "Fixture Computer");
    MainActivity.browserFactory = owner -> {
      WebView view = new WebView(owner) {
        @Override public void loadUrl(String url) { documentLoads.incrementAndGet(); super.loadUrl(url); }
        @Override public void destroy() { web.compareAndSet(this, null); super.destroy(); }
        @Override public void evaluateJavascript(String script, android.webkit.ValueCallback<String> result) {
          if (holdCapture.get() && script.contains("__ccHahaMobileState?.capture")) { delayedCapture.set(result); return; }
          if (holdBackProbe.get() && script.startsWith("typeof window.__CC_HAHA_MOBILE_NAVIGATE_BACK__")) { delayedBackProbe.set(result); return; }
          super.evaluateJavascript(script, result);
        }
        @Override public void setWebViewClient(WebViewClient client) {
          super.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
              WebResourceResponse blocked = client.shouldInterceptRequest(view, request);
              if (blocked != null) return blocked;
              return new WebResourceResponse("text/html", "UTF-8", new java.io.ByteArrayInputStream(HTML.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return client.shouldOverrideUrlLoading(view, request); }
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) { client.onPageStarted(view, url, icon); }
            @Override public void onPageFinished(WebView view, String url) { client.onPageFinished(view, url); }
          });
        }
      };
      web.set(view);
      return view;
    };
  }

  @After public void cleanup() throws Exception {
    MainActivity.backgroundTask = activity -> activity.moveTaskToBack(true);
    MainActivity.temporaryProbe = SessionProbe::read;
    MainActivity.connector = new ReconnectClient(new NativeTransport.Https(), new DeviceKeys(), System::currentTimeMillis)::connect;
    MainActivity.browserFactory = WebView::new;
    CountDownLatch cleared = new CountDownLatch(2);
    instrumentation.runOnMainSync(() -> {
      if (BrowserProfiles.supported()) {
        BrowserProfiles.clearNamed(profile(ORIGIN), cleared::countDown);
        BrowserProfiles.clearNamed(profile(ORIGIN + ":8443"), cleared::countDown);
      } else {
        cleared.countDown(); cleared.countDown();
      }
    });
    assertTrue(cleared.await(10, TimeUnit.SECONDS));
    instrumentation.getTargetContext().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).edit().clear().commit();
  }

  @Test public void scanLinkShowsLiveSessionApprovalAndRestoresAfterBackground() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      screenshot("computers-empty.png");
      scenario.onActivity(activity -> {
        assertTrue("Update emulator System WebView to support profiles", BrowserProfiles.supported());
        assertTrue(activity.acceptLink(qr()));

      });
      awaitText("Live output from computer");
      scenario.onActivity(activity -> {
        assertFalse(web.get().getSettings().getAllowFileAccess());
        assertFalse(web.get().getSettings().getAllowContentAccess());
        assertEquals(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW, web.get().getSettings().getMixedContentMode());
      });
      awaitVisual();
      screenshot("fixture-session.png");
      evaluate("document.querySelector('#approval').click();'ok'");
      assertTrue(evaluate("document.body.textContent").contains("Approved"));
      WebView retained = web.get();
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
      assertSame("A short app switch must keep the loaded document", retained, web.get());
      assertTrue(evaluate("document.body.textContent").contains("Approved"));
      String stored = instrumentation.getTargetContext().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).getString("data", "");
      assertFalse(stored.contains("abcdefghijklmnop"));
      assertFalse(stored.contains("#pair"));
      scenario.onActivity(MainActivity::showComputers);
    }
  }

  @Test public void computerProfilesPersistCookiesWithoutSharingAcrossPorts() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        assertTrue(BrowserProfiles.supported());
        assertTrue(activity.acceptLink(qr()));
      });
      CountDownLatch cookie = new CountDownLatch(1);
      instrumentation.runOnMainSync(() -> BrowserProfiles.named(profile(ORIGIN)).getCookieManager().setCookie(ORIGIN,
          "__Host-haha-remote=fixture-token; Secure; HttpOnly; Path=/; Max-Age=3600", value -> cookie.countDown()));
      assertTrue(cookie.await(10, TimeUnit.SECONDS));
      scenario.onActivity(activity -> {
        BrowserProfiles.named(profile(ORIGIN)).getCookieManager().flush();
        assertTrue(BrowserProfiles.named(profile(ORIGIN)).getCookieManager().getCookie(ORIGIN).contains("fixture-token"));
        assertNull(BrowserProfiles.named(profile(ORIGIN + ":8443")).getCookieManager().getCookie(ORIGIN));
        activity.showComputers();
      });
      scenario.recreate();
      scenario.onActivity(activity -> {
        assertTrue(BrowserProfiles.named(profile(ORIGIN)).getCookieManager().getCookie(ORIGIN).contains("fixture-token"));
        assertTrue(activity.acceptLink(qr()));
      });
      awaitText("Live output from computer");
      evaluate("localStorage.setItem('fixture-session-state','private');'ok'");
      scenario.onActivity(MainActivity::showComputers);
      CountDownLatch removed = new CountDownLatch(1);
      instrumentation.runOnMainSync(() -> BrowserProfiles.clearNamed(profile(ORIGIN), removed::countDown));
      assertTrue(removed.await(10, TimeUnit.SECONDS));
      scenario.onActivity(activity -> {
        assertNull("Removing a computer clears its authentication immediately", BrowserProfiles.cookiesNamed(profile(ORIGIN)).getCookie(ORIGIN));
        assertTrue(activity.acceptLink(qr()));
      });
      awaitText("Live output from computer");
      assertEquals("null", evaluate("localStorage.getItem('fixture-session-state')"));
    }
  }

  @Test public void backgroundRecreatesVerifiedNewOriginAndRestoresOnlyUnsentDraftAndSession() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> assertTrue(activity.acceptLink(qr())));
      awaitText("Live output from computer");
      evaluate("window.selectedSession='session_kept';document.querySelector('#draft').value='Unsent draft stays private';'ok'");
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
      Thread.sleep(400);
      endpoint.set(ORIGIN + ":8443");
      WebView retained = web.get();
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
      assertSame(retained, web.get());
      scenario.onActivity(MainActivity::recoverConnection);
      awaitReplacement(retained);
      awaitText("Live output from computer");
      long deadline = System.currentTimeMillis() + 10000;
      while (!evaluate("document.querySelector('#draft').value").contains("Unsent draft stays private") && System.currentTimeMillis() < deadline) Thread.sleep(100);
      assertEquals("\"session_kept\"", evaluate("window.selectedSession"));
      assertEquals("\"Unsent draft stays private\"", evaluate("document.querySelector('#draft').value"));
      String stored = instrumentation.getTargetContext().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).getString("data", "");
      assertFalse(stored.contains("never-copy"));
      assertTrue(stored.contains("Unsent draft stays private"));
      assertEquals(ORIGIN + ":8443", new ComputerRecords(stored).computers().getJSONObject(0).getString("origin"));
    }
  }

  @Test public void defaultTemporaryQrWorksButStoredLegacyRecordsDoNotProbeBeforeScan() throws Exception {
    java.util.concurrent.atomic.AtomicInteger probes = new java.util.concurrent.atomic.AtomicInteger();
    MainActivity.temporaryProbe = (origin, cookie) -> { probes.incrementAndGet(); return new SessionProbe.Result(SessionProbe.State.UNPAIRED, "Temporary fixture"); };
    Context context = instrumentation.getTargetContext();
    ComputerRecords stored = new ComputerRecords("{}");
    stored.add(RemoteUrl.parse(ORIGIN + "/remote"), "Old temporary computer");
    context.getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).edit().putString("data", stored.serialize()).commit();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      Thread.sleep(300);
      assertEquals(0, probes.get());
      assertNull(web.get());
      scenario.onActivity(activity -> assertTrue(activity.acceptLink(ORIGIN + "/remote#pair=abcdefghijklmnop")));
      awaitText("Live output from computer");
      assertTrue(probes.get() > 0);
      String saved = context.getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).getString("data", "");
      assertFalse(saved.contains("abcdefghijklmnop"));
      assertTrue(new ComputerRecords(saved).computers().getJSONObject(0).getBoolean("legacy"));
    }
    CountDownLatch cleared = new CountDownLatch(1);
    instrumentation.runOnMainSync(() -> BrowserProfiles.clear(ORIGIN, cleared::countDown));
    assertTrue(cleared.await(10, TimeUnit.SECONDS));
  }

  @Test public void systemDocumentSelectionReadsChosenBytesWithContentAccessDisabled() throws Exception {
    Uri fixture = Uri.parse("content://com.cchaha.mobile.test.fixture/file");
    instrumentation.getContext().grantUriPermission("com.cchaha.mobile", fixture, Intent.FLAG_GRANT_READ_URI_PERMISSION);
    Intent selected = new Intent().setData(fixture).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(new IntentFilter(Intent.ACTION_CHOOSER),
        new Instrumentation.ActivityResult(android.app.Activity.RESULT_OK, selected), true);
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> assertTrue(activity.acceptLink(qr())));
      awaitText("Live output from computer");
      tapElement("#file");
      instrumentation.waitForIdleSync();
      awaitText("fixture upload bytes");
      assertEquals(1, monitor.getHits());
      assertFalse(evaluate("document.querySelector('#file').value").contains("content://"));
    } finally {
      instrumentation.removeMonitor(monitor);
      instrumentation.getContext().revokeUriPermission(fixture, Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
  }


  @Test public void coldLaunchResumesLastComputerAndChromeKeepsActionsInMenu() throws Exception {
    seedLastComputer();
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(SessionProbe.State.ONLINE, ORIGIN, 1, null, null, "Fixture Computer");
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
      awaitVisual();
      scenario.onActivity(activity -> {
        String visible = screen(activity.getWindow().getDecorView());
        assertTrue(visible.contains(activity.getString(R.string.connected)));
        assertFalse("Copy belongs in the menu", visible.contains(activity.getString(R.string.copy_link)));
        assertFalse("Computer list belongs in the menu", visible.contains(activity.getString(R.string.back_computers)));
        android.view.ViewGroup root = (android.view.ViewGroup) web.get().getParent();
        assertEquals(Math.round(44 * activity.getResources().getDisplayMetrics().density), root.getChildAt(0).getHeight());
      });
      screenshot("compact-connected.png");
      scenario.onActivity(MainActivity::showComputers);
      instrumentation.waitForIdleSync();
      screenshot("computers-saved.png");
      scenario.recreate();
      scenario.onActivity(activity -> {
        assertNull("Recreation must preserve an intentional return to computers", web.get());
        assertTrue(screen(activity.getWindow().getDecorView()).contains(activity.getString(R.string.computers)));
        assertFalse("Connection address is available through the menu", screen(activity.getWindow().getDecorView()).contains(ORIGIN));
      });
    }
    try (ActivityScenario<MainActivity> reopened = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
    }
  }

  @Test public void cancellingAutomaticReconnectIgnoresTheLateSuccess() throws Exception {
    seedLastComputer();
    CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1), returned = new CountDownLatch(1);
    MainActivity.connector = (record, cookie) -> {
      started.countDown();
      try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
      returned.countDown();
      return new ReconnectClient.Result(SessionProbe.State.ONLINE, ORIGIN, 1, null, null, "Fixture Computer");
    };
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      assertTrue(started.await(5, TimeUnit.SECONDS));
      instrumentation.waitForIdleSync();
      screenshot("restoring-connection.png");
      scenario.onActivity(activity -> {
        assertTrue(screen(activity.getWindow().getDecorView()).contains(activity.getString(R.string.resuming)));
        assertTrue(press(activity.getWindow().getDecorView(), activity.getString(R.string.back_computers)));
      });
      release.countDown();
      assertTrue(returned.await(5, TimeUnit.SECONDS));
      awaitNativeText(scenario, R.string.online);
      scenario.onActivity(activity -> {
        assertNull("A cancelled result must not reopen chat", web.get());
        assertTrue(screen(activity.getWindow().getDecorView()).contains(activity.getString(R.string.computers)));
      });
    } finally { release.countDown(); }
  }

  @Test public void failedAutomaticReconnectReturnsToActionableComputerList() throws Exception {
    seedLastComputer();
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(SessionProbe.State.OFFLINE, ORIGIN, 0, null, null, null);
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitNativeText(scenario, R.string.offline);
      scenario.onActivity(activity -> {
        String visible = screen(activity.getWindow().getDecorView());
        assertNull(web.get());
        assertTrue(visible.contains(activity.getString(R.string.computers)));
        assertTrue(visible.contains(activity.getString(R.string.connect)));
        assertFalse(visible.contains(activity.getString(R.string.resuming)));
      });
      screenshot("offline-recovery.png");
    }
  }


  @Test public void foregroundRetryAndVerifiedOriginRotationPreserveTheCurrentDraft() throws Exception {
    seedLastComputer();
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(SessionProbe.State.ONLINE, endpoint.get(), endpoint.get().equals(ORIGIN) ? 1 : 2, null, null, "Fixture Computer");
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
      evaluate("window.selectedSession='session_retry';document.querySelector('#draft').value='Kept through retry';'ok'");
      WebView previous = web.get();
      retryFromMenu(scenario);
      awaitReplacement(previous);
      awaitDraft("Kept through retry");
      assertEquals("\"session_retry\"", evaluate("window.selectedSession"));
      evaluate("document.querySelector('#draft').value='Kept through rotation';'ok'");
      endpoint.set(ORIGIN + ":8443");
      previous = web.get();
      scenario.onActivity(MainActivity::recoverConnection);
      awaitReplacement(previous);
      awaitDraft("Kept through rotation");
      assertEquals("\"" + ORIGIN + ":8443\"", evaluate("location.origin"));
      assertEquals("\"session_retry\"", evaluate("window.selectedSession"));
    }
  }

  @Test public void cancelledRetryIgnoresLateDraftCaptureAndItsTimeout() throws Exception {
    seedLastComputer();
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(SessionProbe.State.ONLINE, ORIGIN, 1, null, null, "Fixture Computer");
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
      holdCapture.set(true);
      retryFromMenu(scenario);
      assertNotNull("Retry must capture before closing the active WebView", delayedCapture.get());
      scenario.onActivity(activity -> {
        activity.showComputers();
        delayedCapture.get().onReceiveValue("{\"version\":1,\"sessionId\":\"late\",\"drafts\":[{\"sessionId\":\"late\",\"text\":\"Late capture must be ignored\"}]}");
      });
      Thread.sleep(350);
      scenario.onActivity(activity -> {
        assertNull("Cancelled capture and timeout must not navigate", web.get());
        assertTrue(screen(activity.getWindow().getDecorView()).contains(activity.getString(R.string.computers)));
      });
      assertFalse(instrumentation.getTargetContext().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).getString("data", "").contains("Late capture must be ignored"));
    }
  }


  @Test public void explicitComputerMenuPreservesDraftWhenReturningToChat() throws Exception {
    seedLastComputer();
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(SessionProbe.State.ONLINE, ORIGIN, 1, null, null, "Fixture Computer");
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
      evaluate("window.selectedSession='session_switch';document.querySelector('#draft').value='Kept when switching computers';'ok'");
      connectionMenuAction(scenario, R.string.back_computers);
      awaitNativeText(scenario, R.string.computers);
      scenario.onActivity(activity -> {
        assertNull("Leaving chat closes its WebView after capture", web.get());
        assertTrue(press(activity.getWindow().getDecorView(), activity.getString(R.string.connect)));
      });
      awaitDraft("Kept when switching computers");
      assertEquals("\"session_switch\"", evaluate("window.selectedSession"));
    }
  }


  @Test public void shortBackgroundAndDuplicateNetworkEventsDoNotRecreateOrRevalidateThePage() throws Exception {
    seedLastComputer();
    java.util.concurrent.atomic.AtomicInteger checks = new java.util.concurrent.atomic.AtomicInteger();
    MainActivity.connector = (record, cookie) -> {
      checks.incrementAndGet();
      return new ReconnectClient.Result(SessionProbe.State.ONLINE, ORIGIN, 1, null, null, "Fixture Computer");
    };
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
      assertEquals("Loading the page must not immediately probe again", 1, checks.get());
      WebView retained = web.get();
      int loads = documentLoads.get();
      evaluate("window.selectedSession='warm_session';document.querySelector('#draft').value='Warm draft';window.runtimeOnly='still here';'ok'");
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
      Thread.sleep(400);
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
      scenario.onActivity(activity -> {
        android.net.Network network = activity.getSystemService(android.net.ConnectivityManager.class).getActiveNetwork();
        assertNotNull(network);
        activity.availableNetwork(network);
        activity.availableNetwork(network);
      });
      instrumentation.waitForIdleSync();
      assertSame(retained, web.get());
      assertEquals("A warm resume must not load the document again", loads, documentLoads.get());
      assertEquals(1, checks.get());
      assertEquals("\"still here\"", evaluate("window.runtimeOnly"));
      assertEquals("\"Warm draft\"", evaluate("document.querySelector('#draft').value"));
      assertEquals("1", evaluate("window.resumeCount"));
    }
  }

  @Test public void renewingCookieAtTheSameOriginKeepsTheDocumentAndNotifiesItOnce() throws Exception {
    seedLastComputer();
    java.util.concurrent.atomic.AtomicBoolean renew = new java.util.concurrent.atomic.AtomicBoolean();
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(SessionProbe.State.ONLINE, ORIGIN, 1, null,
        renew.getAndSet(false) ? "__Host-haha-remote=fixture-token; Secure; HttpOnly; Path=/; Max-Age=3600" : null, "Fixture Computer");
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
      WebView retained = web.get();
      int loads = documentLoads.get();
      evaluate("window.runtimeOnly='kept during cookie refresh';window.resumeCount=0;'ok'");
      renew.set(true);
      scenario.onActivity(MainActivity::recoverConnection);
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
      while (System.nanoTime() < deadline && Integer.parseInt(evaluate("window.resumeCount")) < 2) Thread.sleep(50);
      assertSame(retained, web.get());
      assertEquals(loads, documentLoads.get());
      assertEquals("\"kept during cookie refresh\"", evaluate("window.runtimeOnly"));
      // One explicit Refresh plus one cookie-ready event, with no fake focus or visibility events.
      assertEquals("2", evaluate("window.resumeCount"));
    }
  }

  @Test public void systemBackUsesTheWebStackAndBackgroundsAtChatRootWithoutOpeningComputers() throws Exception {
    seedLastComputer();
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(SessionProbe.State.ONLINE, ORIGIN, 1, null, null, "Fixture Computer");
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
      WebView retained = web.get();
      evaluate("window.backStack=['chat','drawer','settings'];'ok'");
      scenario.onActivity(MainActivity::onBackPressed);
      awaitScriptValue("window.backStack.length", "2");
      assertEquals(0, backgroundRequests.get());
      scenario.onActivity(MainActivity::onBackPressed);
      awaitScriptValue("window.backStack.length", "1");
      assertEquals(0, backgroundRequests.get());
      scenario.onActivity(MainActivity::onBackPressed);
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (backgroundRequests.get() == 0 && System.nanoTime() < deadline) Thread.sleep(50);
      assertEquals(1, backgroundRequests.get());
      assertSame(retained, web.get());
      scenario.onActivity(activity -> assertFalse(screen(activity.getWindow().getDecorView()).contains(activity.getString(R.string.computers))));
    }
  }

  @Test public void lateBackProbeCannotDispatchASecondNavigationAfterNativeFallback() throws Exception {
    seedLastComputer();
    MainActivity.connector = (record, cookie) -> new ReconnectClient.Result(SessionProbe.State.ONLINE, ORIGIN, 1, null, null, "Fixture Computer");
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      awaitText("Live output from computer");
      evaluate("window.backStack=['chat','drawer'];'ok'");
      holdBackProbe.set(true);
      scenario.onActivity(MainActivity::onBackPressed);
      assertNotNull(delayedBackProbe.get());
      Thread.sleep(500);
      instrumentation.waitForIdleSync();
      assertEquals(1, backgroundRequests.get());
      scenario.onActivity(activity -> delayedBackProbe.get().onReceiveValue("true"));
      assertEquals("2", evaluate("window.backStack.length"));
      assertEquals(1, backgroundRequests.get());
    }
  }

  private void awaitScriptValue(String script, String expected) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while (System.nanoTime() < deadline) {
      if (expected.equals(evaluate(script))) return;
      Thread.sleep(50);
    }
    assertEquals(expected, evaluate(script));
  }

  private void retryFromMenu(ActivityScenario<MainActivity> scenario) {
    connectionMenuAction(scenario, R.string.retry);
  }

  private void connectionMenuAction(ActivityScenario<MainActivity> scenario, int action) {
    scenario.onActivity(activity -> assertTrue(pressDescription(activity.getWindow().getDecorView(), activity.getString(R.string.connection_menu))));
    instrumentation.waitForIdleSync();
    android.view.accessibility.AccessibilityNodeInfo popup = instrumentation.getUiAutomation().getRootInActiveWindow();
    assertNotNull(popup);
    String label = instrumentation.getTargetContext().getString(action);
    boolean clicked = false;
    for (android.view.accessibility.AccessibilityNodeInfo node : popup.findAccessibilityNodeInfosByText(label)) {
      for (int level = 0; node != null && level < 4; level++, node = node.getParent()) {
        if (node.isClickable() && node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)) { clicked = true; break; }
      }
      if (clicked) break;
    }
    assertTrue("Connection menu exposes " + label, clicked);
    instrumentation.waitForIdleSync();
  }

  private static boolean pressDescription(android.view.View view, String description) {
    if (view instanceof android.widget.Button && description.equals(view.getContentDescription())) return view.performClick();
    if (view instanceof android.view.ViewGroup) {
      android.view.ViewGroup group = (android.view.ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) if (pressDescription(group.getChildAt(i), description)) return true;
    }
    return false;
  }

  private void awaitReplacement(WebView previous) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
    while (System.nanoTime() < deadline) {
      if (web.get() != null && web.get() != previous) return;
      Thread.sleep(50);
    }
    fail("Connection did not replace the previous WebView");
  }

  private void awaitDraft(String expected) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
    while (System.nanoTime() < deadline) {
      if (web.get() != null && evaluate("document.querySelector('#draft')?.value ?? ''").contains(expected)) return;
      Thread.sleep(50);
    }
    fail("Unsent draft was not restored: " + expected);
  }

  private void seedLastComputer() throws Exception {
    ComputerRecords saved = new ComputerRecords("{}");
    org.json.JSONObject record = saved.add(RemoteUrl.parse(qr()), "Fixture Computer");
    record.put("deviceId", RemoteProtocol.nonce());
    saved.opened(record);
    instrumentation.getTargetContext().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE).edit().putString("data", saved.serialize()).commit();
  }

  private static String screen(android.view.View view) {
    StringBuilder result = new StringBuilder();
    if (view.getVisibility() != android.view.View.VISIBLE) return "";
    if (view instanceof android.widget.TextView) result.append(((android.widget.TextView) view).getText()).append('\n');
    if (view instanceof android.view.ViewGroup) {
      android.view.ViewGroup group = (android.view.ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) result.append(screen(group.getChildAt(i)));
    }
    return result.toString();
  }

  private static boolean press(android.view.View view, String label) {
    if (view instanceof android.widget.Button && label.contentEquals(((android.widget.Button) view).getText())) return view.performClick();
    if (view instanceof android.view.ViewGroup) {
      android.view.ViewGroup group = (android.view.ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) if (press(group.getChildAt(i), label)) return true;
    }
    return false;
  }

  private void awaitNativeText(ActivityScenario<MainActivity> scenario, int resource) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
    java.util.concurrent.atomic.AtomicBoolean visible = new java.util.concurrent.atomic.AtomicBoolean();
    while (System.nanoTime() < deadline) {
      scenario.onActivity(activity -> visible.set(screen(activity.getWindow().getDecorView()).contains(activity.getString(resource))));
      if (visible.get()) return;
      Thread.sleep(50);
    }
    fail("Native screen did not show expected text resource " + resource);
  }

  private String evaluate(String script) throws Exception {
    AtomicReference<String> result = new AtomicReference<>();
    CountDownLatch ready = new CountDownLatch(1);
    instrumentation.runOnMainSync(() -> {
      WebView current = web.get();
      if (current == null) { result.set("null"); ready.countDown(); }
      else current.evaluateJavascript(script, value -> { result.set(value); ready.countDown(); });
    });
    assertTrue(ready.await(10, TimeUnit.SECONDS));
    return result.get();
  }

  private void awaitText(String text) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
    while (System.nanoTime() < deadline) {
      if (web.get() != null && evaluate("document.body ? document.body.textContent : ''").contains(text)) return;
      Thread.sleep(100);
    }
    fail("Fixture did not render expected session output: " + evaluate("document.body.textContent"));
  }

  private void tapElement(String selector) throws Exception {
    awaitVisual();
    org.json.JSONArray point = new org.json.JSONArray(evaluate("(()=>{const r=document.querySelector('" + selector + "').getBoundingClientRect();return [r.x+20,r.y+r.height/2,devicePixelRatio]})()"));
    int[] location = new int[2];
    instrumentation.runOnMainSync(() -> web.get().getLocationOnScreen(location));
    float x = location[0] + (float) (point.getDouble(0) * point.getDouble(2));
    float y = location[1] + (float) (point.getDouble(1) * point.getDouble(2));
    long now = android.os.SystemClock.uptimeMillis();
    android.view.MotionEvent down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, x, y, 0);
    android.view.MotionEvent up = android.view.MotionEvent.obtain(now, now + 50, android.view.MotionEvent.ACTION_UP, x, y, 0);
    instrumentation.sendPointerSync(down);
    instrumentation.sendPointerSync(up);
    down.recycle(); up.recycle();
  }

  private void awaitVisual() throws Exception {
    CountDownLatch drawn = new CountDownLatch(1);
    instrumentation.runOnMainSync(() -> web.get().postVisualStateCallback(1, new WebView.VisualStateCallback() {
      @Override public void onComplete(long requestId) { web.get().postDelayed(drawn::countDown, 250); }
    }));
    assertTrue("WebView compositor must present a frame", drawn.await(10, TimeUnit.SECONDS));
    instrumentation.waitForIdleSync();
  }

  private void screenshot(String name) throws Exception {
    java.io.File directory = instrumentation.getTargetContext().getExternalFilesDir("smoke");
    assertNotNull(directory);
    try (var stream = new java.io.FileOutputStream(new java.io.File(directory, name))) {
      instrumentation.getUiAutomation().takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, stream);
    }
  }
}
