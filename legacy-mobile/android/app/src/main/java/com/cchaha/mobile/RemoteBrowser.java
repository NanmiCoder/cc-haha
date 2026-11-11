package com.cchaha.mobile;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Message;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;

public final class RemoteBrowser {
  public interface Events {
    void external(String url);
    void failure();
    void loaded();
    void progress(int value);
    boolean chooseFiles(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams parameters);
  }

  @SuppressLint("SetJavaScriptEnabled")
  public static void configure(WebView view, String origin, Events events) {
    configure(view, origin, BrowserProfiles.key(origin), events);
  }

  @SuppressLint("SetJavaScriptEnabled")
  public static void configure(WebView view, String origin, String profileName, Events events) {
    BrowserProfiles.attachNamed(view, profileName);
    BrowserProfiles.cookiesNamed(profileName).setAcceptThirdPartyCookies(view, false);
    view.setSaveEnabled(false);
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setSafeBrowsingEnabled(true);
    settings.setGeolocationEnabled(false);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setSupportMultipleWindows(true);
    // Honor server cache headers so hashed H5 assets survive mobile reconnects.
    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
    WebView.setWebContentsDebuggingEnabled(false);
    view.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
        String url = request.getUrl().toString();
        NavigationPolicy.Decision action = NavigationPolicy.decide(origin, url, request.isForMainFrame());
        if (action == NavigationPolicy.Decision.EXTERNAL && request.hasGesture()) events.external(url);
        return action != NavigationPolicy.Decision.INTERNAL;
      }

      @Override public void onPageStarted(WebView webView, String url, Bitmap icon) {
        if (NavigationPolicy.decide(origin, url, true) != NavigationPolicy.Decision.INTERNAL) {
          webView.stopLoading();
          events.failure();
        }
      }

      @Override public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
        // Subresources may use HTTPS CDNs, but never local files or cleartext.
        if (!"https".equals(request.getUrl().getScheme())) return blocked();
        return null;
      }

      @Override public void onReceivedSslError(WebView webView, SslErrorHandler handler, SslError error) {
        handler.cancel();
        events.failure();
      }

      @Override public void onReceivedError(WebView webView, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) events.failure();
      }

      @Override public void onReceivedHttpError(WebView webView, WebResourceRequest request, WebResourceResponse response) {
        if (request.isForMainFrame() && response.getStatusCode() >= 400) events.failure();
      }

      @Override public void onPageFinished(WebView webView, String url) {
        // RemoteAccessGate consumes #pair in a layout effect. Never save history.
        BrowserProfiles.cookiesNamed(profileName).flush();
        events.loaded();
      }
    });
    view.setWebChromeClient(new WebChromeClient() {
      @Override public void onProgressChanged(WebView webView, int progress) { events.progress(progress); }
      @Override public boolean onConsoleMessage(ConsoleMessage message) { return true; }
      @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
      @Override public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
        return events.chooseFiles(callback, parameters);
      }
      @Override public boolean onCreateWindow(WebView webView, boolean dialog, boolean gesture, Message message) {
        if (!gesture) return false;
        // A transient view only captures a target=_blank URL; it never loads it.
        WebView popup = new WebView(webView.getContext());
        popup.getSettings().setJavaScriptEnabled(false);
        popup.getSettings().setAllowFileAccess(false);
        popup.getSettings().setAllowContentAccess(false);
        popup.setWebViewClient(new WebViewClient() {
          @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
            String url = request.getUrl().toString();
            NavigationPolicy.Decision action = NavigationPolicy.decide(origin, url, true);
            if (action == NavigationPolicy.Decision.INTERNAL) webView.loadUrl(url);
            else if (action == NavigationPolicy.Decision.EXTERNAL) events.external(url);
            popup.destroy();
            return true;
          }
        });
        ((WebView.WebViewTransport) message.obj).setWebView(popup);
        message.sendToTarget();
        return true;
      }
    });
  }

  private static WebResourceResponse blocked() {
    return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
  }

  public static void resume(WebView view) {
    view.onResume();
    // One notification per native resume. Synthetic focus + visibility events
    // used to restart the same WebSocket handshake multiple times in succession.
    view.evaluateJavascript("window.dispatchEvent(new Event('cc-haha:resume'));", null);
  }
}
