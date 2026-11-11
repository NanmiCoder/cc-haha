package com.cchaha.mobile;

import android.os.Build;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeWriter;
import java.net.URI;
import java.security.KeyPairGenerator;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Runs the actual Android URI/regex providers; fixture-only and no network or app storage. */
@RunWith(AndroidJUnit4.class)
public class RemoteUrlCompatibilityTest {
  private static final String ORIGIN = "https://pairing-fixture.invalid";
  private static final String PAIR = "abcdefghijklmnop";

  @Test public void androidUriAndRegexAcceptHttpsPairingUrl() throws Exception {
    String input = ORIGIN + "/remote#pair=" + PAIR;
    URI uri = new URI(input);
    assertEquals("https", uri.getScheme());
    assertEquals("pairing-fixture.invalid", uri.getHost());
    assertEquals("/remote", uri.getRawPath());
    assertEquals("pair=" + PAIR, uri.getRawFragment());
    assertFalse("Safe fixture must not match the Android forbidden-character pattern",
        input.matches("(?s).*[\\\\\\s\\p{Cntrl}].*"));
    assertEquals(ORIGIN, RemoteUrl.parse(input).origin);
  }

  @Test public void parsesLegacyAndBoundPairingOnAndroidRuntime() throws Exception {
    String legacy = ORIGIN + "/remote#pair=" + PAIR;
    RemoteUrl legacyUrl = parseWithStage(legacy);
    assertTrue(legacyUrl.pairing);
    assertNull(legacyUrl.hostId);
    assertEquals(legacy, legacyUrl.launchUrl);
    KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
    generator.initialize(2048);
    String key = RemoteProtocol.encode(generator.generateKeyPair().getPublic().getEncoded());
    String bound = legacy + "&v=2&hostKey=" + key
        + "&directory=https%3A%2F%2Fdirectory-fixture.invalid";
    RemoteUrl nativeUrl = parseWithStage(bound);
    assertEquals(64, nativeUrl.hostId.length());
    assertEquals(key, nativeUrl.hostKey);
    assertEquals("https://directory-fixture.invalid", nativeUrl.directory);
    assertEquals(legacy, nativeUrl.launchUrl);
  }

  @Test public void rejectsForbiddenCharactersAndUnsafeUrisOnAndroidRuntime() {
    for (String value : new String[] {
        "http://pairing-fixture.invalid/remote#pair=" + PAIR,
        "https://user@pairing-fixture.invalid/remote#pair=" + PAIR,
        "https://pairing-fixture.invalid:0/remote#pair=" + PAIR,
        "https://pairing-fixture.invalid/remote?other=value#pair=" + PAIR,
        "https://pairing-fixture.invalid\\evil/remote#pair=" + PAIR,
        "https://pairing-fixture.invalid/remote#pair=abcd efghijklmnop",
        "https://pairing-fixture.invalid/remote#pair=abcd\nefghijklmnop",
        "https://pairing-fixture.invalid/remote#pair=abcd\tefghijklmnop",
        "https://pairing-fixture.invalid/remote#pair=abcd\u0000efghijklmnop"
    }) {
      try { RemoteUrl.parse(value); fail("Unsafe fixture was accepted"); }
      catch (IllegalArgumentException expected) { /* Required validation boundary. */ }
    }
  }

  @Test public void zxingLongBoundQrRoundTripPreservesEveryCharacter() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
    generator.initialize(2048);
    String key = RemoteProtocol.encode(generator.generateKeyPair().getPublic().getEncoded());
    String fixture = "https://upon-profits-capture-fixture.trycloudflare.com/remote#pair="
        + PAIR + "_1234567890-ABCDEFGHIJKLMN&v=2&hostKey=" + key
        + "&directory=https%3A%2F%2Fdirectory-fixture.invalid";
    BitMatrix matrix = new QRCodeWriter().encode(fixture, BarcodeFormat.QR_CODE, 288, 288);
    int width = matrix.getWidth(), height = matrix.getHeight();
    int[] pixels = new int[width * height];
    for (int y = 0; y < height; y++) for (int x = 0; x < width; x++)
      pixels[y * width + x] = matrix.get(x, y) ? 0xff000000 : 0xffffffff;
    String decoded = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(
        new RGBLuminanceSource(width, height, pixels)))).getText();
    assertEquals("Scanner payload must preserve all trust fields and percent encoding", fixture, decoded);
    RemoteUrl remote = parseWithStage(decoded);
    assertTrue(remote.pairing);
    assertEquals(key, remote.hostKey);
    assertEquals("https://directory-fixture.invalid", remote.directory);
  }

  private static RemoteUrl parseWithStage(String fixture) {
    try { return RemoteUrl.parse(fixture); }
    catch (RuntimeException error) {
      Log.e("RemoteUrlCompatibility", "SDK=" + Build.VERSION.SDK_INT + " fixture parse stage="
          + error.getClass().getSimpleName() + ":" + error.getMessage());
      throw error;
    }
  }
}
