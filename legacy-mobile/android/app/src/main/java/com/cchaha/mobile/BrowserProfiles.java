package com.cchaha.mobile;

import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import android.webkit.WebView;
import android.webkit.CookieManager;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Cookies and localStorage are isolated even for different ports on one host. */
public final class BrowserProfiles {
  public static boolean supported() { return WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE); }

  static String key(String origin) { return key(null, origin); }

  static String key(String hostId, String origin) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest((hostId == null ? origin : hostId + "\n" + origin).getBytes(StandardCharsets.UTF_8));
      StringBuilder value = new StringBuilder("computer-");
      for (byte b : digest) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
      return value.toString();
    } catch (Exception error) { throw new IllegalStateException("profile_unavailable"); }
  }

  public static Profile get(String origin) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) throw new IllegalStateException("profile_unavailable");
    return named(key(origin));
  }
  public static Profile named(String name) {
    if (!supported() || !name.matches("computer-[a-f0-9]{64}")) throw new IllegalStateException("profile_unavailable");
    return ProfileStore.getInstance().getOrCreateProfile(name);
  }
  public static CookieManager cookiesNamed(String name) { return named(name).getCookieManager(); }
  public static void attachNamed(WebView view, String name) {
    if (!supported()) throw new IllegalStateException("profile_unavailable");
    WebViewCompat.setProfile(view, name);
  }
  public static void removeNamed(String name) {
    if (!supported()) throw new IllegalStateException("profile_unavailable");
    ProfileStore.getInstance().deleteProfile(name);
  }
  public static CookieManager cookies(String origin) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) throw new IllegalStateException("profile_unavailable");
    return get(origin).getCookieManager();
  }
  public static void attach(WebView view, String origin) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) throw new IllegalStateException("profile_unavailable");
    WebViewCompat.setProfile(view, key(origin));
  }
  public static void remove(String origin) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) throw new IllegalStateException("profile_unavailable");
    ProfileStore.getInstance().deleteProfile(key(origin));
  }
  public static void clear(String origin, Runnable complete) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) throw new IllegalStateException("profile_unavailable");
    clearNamed(key(origin), complete);
  }
  public static void clearNamed(String name, Runnable complete) {
    Profile profile = named(name);
    profile.getWebStorage().deleteAllData();
    profile.getCookieManager().removeAllCookies(ignored -> {
      profile.getCookieManager().flush();
      complete.run();
    });
  }
}
