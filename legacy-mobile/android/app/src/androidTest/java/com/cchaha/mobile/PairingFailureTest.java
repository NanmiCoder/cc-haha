package com.cchaha.mobile;

import android.app.Instrumentation;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.zxing.client.android.Intents;
import com.google.zxing.integration.android.IntentIntegrator;
import java.security.KeyPairGenerator;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Device component failures are local fixtures: no WebView, network, account or model calls. */
@RunWith(AndroidJUnit4.class)
public class PairingFailureTest {
  private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  private SharedPreferences preferences;
  private String qr;
  private CountDownLatch connected;
  private static final String ORIGIN = "https://pairing-fixture.invalid";

  @Before public void setup() throws Exception {
    preferences = instrumentation.getTargetContext().getSharedPreferences(MainActivity.STORE, Context.MODE_PRIVATE);
    preferences.edit().clear().commit();
    KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
    generator.initialize(2048);
    String key = RemoteProtocol.encode(generator.generateKeyPair().getPublic().getEncoded());
    qr = ORIGIN + "/remote#pair=abcdefghijklmnop&v=2&hostKey=" + key + "&directory=https%3A%2F%2Fdirectory-fixture.invalid";
    connected = new CountDownLatch(1);
    MainActivity.profileSupport = () -> true;
    MainActivity.profileCookies = (profile, origin) -> null;
    MainActivity.connector = (record, cookie) -> {
      connected.countDown();
      return new ReconnectClient.Result(SessionProbe.State.OFFLINE, ORIGIN, 0, null, null, null);
    };
  }

  @After public void cleanup() {
    MainActivity.profileSupport = BrowserProfiles::supported;
    MainActivity.profileCookies = (profile, origin) -> BrowserProfiles.cookiesNamed(profile).getCookie(origin + "/");
    MainActivity.recordWriter = (store, value) -> store.edit().putString("data", value).commit();
    MainActivity.connector = new ReconnectClient(new NativeTransport.Https(), new DeviceKeys(), System::currentTimeMillis)::connect;
    preferences.edit().clear().commit();
  }

  @Test public void acceptedComputerIsVisibleBeforeTheFirstConnectionCompletes() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        assertTrue(activity.acceptLink(qr));
        assertNull(activity.linkError());
        assertTrue(screen(activity).contains("pairing-fixture.invalid"));
        assertFalse(screen(activity).contains(activity.getString(R.string.empty_title)));
      });
      assertTrue(connected.await(5, TimeUnit.SECONDS));
      assertEquals(1, new ComputerRecords(preferences.getString("data", "{}")).computers().length());
      assertFalse(preferences.getString("data", "").contains("abcdefghijklmnop"));
    }
  }

  @Test public void cookieFailureKeepsCardAndRefreshReleasesTheFailedAttempt() throws Exception {
    MainActivity.profileCookies = (profile, origin) -> { throw new IllegalStateException("fixture_component_failure"); };
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        assertTrue(activity.acceptLink(qr));
        assertNull(activity.linkError());
        assertTrue(screen(activity).contains("pairing-fixture.invalid"));
        assertTrue(screen(activity).contains("[PROFILE]"));
        assertFalse(screen(activity).contains("[QR]"));
        assertEquals(1, connected.getCount());
        MainActivity.profileCookies = (profile, origin) -> null;
        press(activity, R.string.refresh);
      });
      assertTrue("Refresh must not retain the failed checking ticket", connected.await(5, TimeUnit.SECONDS));
    }
  }

  @Test public void unsupportedWebviewKeepsSavedComputerAndConnectCanRetry() throws Exception {
    MainActivity.profileSupport = () -> false;
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        assertTrue(activity.acceptLink(qr));
        assertTrue(screen(activity).contains("[WEBVIEW]"));
        assertTrue(screen(activity).contains(activity.getString(R.string.webview_update)));
        assertEquals(1, connected.getCount());
        MainActivity.profileSupport = () -> true;
        press(activity, R.string.connect);
      });
      assertTrue(connected.await(5, TimeUnit.SECONDS));
    }
  }

  @Test public void webviewProbeExceptionIsNotAStorageOrQrFailure() throws Exception {
    MainActivity.profileSupport = () -> { throw new IllegalStateException("fixture_provider_unavailable"); };
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        assertTrue(activity.acceptLink(qr));
        assertNull(activity.linkError());
        assertTrue(screen(activity).contains("[WEBVIEW]"));
        assertFalse(screen(activity).contains(activity.getString(R.string.storage_error)));
        assertEquals(1, connected.getCount());
      });
    }
  }

  @Test public void failedSavePreservesTheOldListAndReportsSaveStage() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      String original = preferences.getString("data", "");
      scenario.onActivity(activity -> {
        MainActivity.recordWriter = (store, value) -> false;
        assertFalse(activity.acceptLink(qr));
        assertTrue(activity.linkError().endsWith("[SAVE]"));
        assertTrue(screen(activity).contains(activity.getString(R.string.empty_title)));
        assertEquals(original, preferences.getString("data", ""));
        assertEquals(1, connected.getCount());
        MainActivity.recordWriter = (store, value) -> store.edit().putString("data", value).commit();
        assertTrue(activity.acceptLink(qr));
      });
      assertTrue(connected.await(5, TimeUnit.SECONDS));
      assertEquals(1, new ComputerRecords(preferences.getString("data", "{}")).computers().length());
    }
  }

  @Test public void invalidQrAndChangedDirectoryHaveSeparateErrorsWithoutLeakingInput() throws Exception {
    MainActivity.profileSupport = () -> false;
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> {
        String original = preferences.getString("data", "");
        assertFalse(activity.acceptLink("http://unsafe.invalid/remote#pair=never-show-this-value"));
        assertTrue(activity.linkError().endsWith("[QR-LINK]"));
        assertFalse(activity.linkError().contains("never-show-this-value"));
        assertFalse(activity.acceptLink(qr.replaceAll("hostKey=[^&]+", "hostKey=AA")));
        assertTrue(activity.linkError().endsWith("[QR-KEY]"));
        assertFalse(activity.acceptLink(qr.replace("&v=2", "&v=3")));
        assertTrue(activity.linkError().endsWith("[QR-VERSION]"));
        assertEquals(original, preferences.getString("data", ""));
        assertTrue(activity.acceptLink(qr));
        String saved = preferences.getString("data", "");
        assertFalse(activity.acceptLink(qr.replace("directory-fixture.invalid", "different-directory.invalid")));
        assertTrue(activity.linkError().endsWith("[TRUST]"));
        assertEquals(saved, preferences.getString("data", ""));
      });
    }
  }

  @Test public void scanFailureKeepsTheCompleteReasonVisibleUntilDismissed() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      scenario.onActivity(activity -> activity.onActivityResult(IntentIntegrator.REQUEST_CODE, Activity.RESULT_OK,
          new Intent().putExtra(Intents.Scan.RESULT, qr.replaceAll("hostKey=[^&]+", "hostKey=AA"))
            .putExtra(Intents.Scan.RESULT_FORMAT, "QR_CODE")));
      instrumentation.waitForIdleSync();
      android.view.accessibility.AccessibilityNodeInfo root = null;
      long deadline = System.currentTimeMillis() + 5000;
      while (System.currentTimeMillis() < deadline) {
        root = instrumentation.getUiAutomation().getRootInActiveWindow();
        if (root != null && !root.findAccessibilityNodeInfosByText("[QR-KEY]").isEmpty()) break;
        if (root != null) root.recycle();
        root = null;
        Thread.sleep(50);
      }
      assertNotNull(root);
      assertFalse("Failure code must be in the dialog title, not a truncated transient toast",
          root.findAccessibilityNodeInfosByText("[QR-KEY]").isEmpty());
      assertFalse("The complete explanation must remain visible",
          root.findAccessibilityNodeInfosByText(instrumentation.getTargetContext().getString(R.string.invalid_url)).isEmpty());
      assertFalse("A dismiss button distinguishes a persistent error dialog from a toast",
          root.findAccessibilityNodeInfosByText(instrumentation.getTargetContext().getString(android.R.string.ok)).isEmpty());
      assertTrue(root.findAccessibilityNodeInfosByText("abcdefghijklmnop").isEmpty());
      assertTrue(root.findAccessibilityNodeInfosByText("hostKey=AA").isEmpty());
      root.recycle();
      java.io.File screenshot = new java.io.File(instrumentation.getTargetContext().getExternalFilesDir(null), "pairing-error-dialog.png");
      android.graphics.Bitmap pixels = instrumentation.getUiAutomation().takeScreenshot();
      assertNotNull(pixels);
      try (java.io.FileOutputStream stream = new java.io.FileOutputStream(screenshot)) {
        assertTrue(pixels.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream));
      }
      pixels.recycle();
    }
  }

  private static String screen(MainActivity activity) { return text(activity.getWindow().getDecorView()); }
  private static String text(View view) {
    StringBuilder value = new StringBuilder();
    if (view instanceof TextView) value.append(((TextView) view).getText()).append('\n');
    if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) value.append(text(((ViewGroup) view).getChildAt(i)));
    return value.toString();
  }
  private static void press(MainActivity activity, int resource) {
    assertTrue("Expected visible action", click(activity.getWindow().getDecorView(), activity.getString(resource)));
  }
  private static boolean click(View view, String label) {
    if (view instanceof Button && ((Button) view).getText().toString().equals(label)) return view.performClick();
    if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) if (click(((ViewGroup) view).getChildAt(i), label)) return true;
    return false;
  }
}
