package com.cchaha.mobile;

import java.net.CookieHandler;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** An isolated native transport: no cookie jar, redirects, credential logging or WebView. */
public interface NativeTransport {
  final class Reply {
    public final int status;
    public final JSONObject body;
    public final List<String> cookies;
    public Reply(int status, JSONObject body, List<String> cookies) { this.status = status; this.body = body; this.cookies = cookies; }
  }
  Reply request(String origin, String path, JSONObject body, String cookie) throws Exception;

  final class Https implements NativeTransport {
    interface Connections { HttpsURLConnection open(URL url) throws Exception; }
    private final Connections connections;
    public Https() { this(url -> (HttpsURLConnection) url.openConnection()); }
    Https(Connections connections) { this.connections = connections; }
    @Override public Reply request(String origin, String path, JSONObject body, String cookie) throws Exception {
      RemoteUrl.requireOrigin(origin);
      // Future libraries must not silently install an ambient authentication jar.
      if (CookieHandler.getDefault() != null) throw new IllegalStateException("ambient_cookie_handler");
      HttpsURLConnection connection = connections.open(new URL(origin + path));
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
      connection.setUseCaches(false);
      connection.setRequestProperty("Accept", "application/json");
      if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
      try {
        if (body != null) {
          byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
          connection.setRequestMethod("POST"); connection.setRequestProperty("Origin", origin);
          connection.setRequestProperty("Content-Type", "application/json");
          connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
          try (var stream = connection.getOutputStream()) { stream.write(bytes); }
        }
        int status = connection.getResponseCode();
        if (status >= 300 && status < 400) throw new IllegalArgumentException("redirect_rejected");
        var stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        JSONObject response = new JSONObject();
        if (stream != null) try (stream) {
          byte[] bytes = new byte[32769]; int size = 0;
          while (size < bytes.length) { int read = stream.read(bytes, size, bytes.length - size); if (read < 0) break; size += read; }
          if (size > 32768) throw new IllegalArgumentException("response_too_large");
          if (size > 0) response = new JSONObject(new String(bytes, 0, size, StandardCharsets.UTF_8));
        }
        List<String> cookies = new ArrayList<>();
        for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
          if ("set-cookie".equalsIgnoreCase(header.getKey())) cookies.addAll(header.getValue());
        }
        return new Reply(status, response, Collections.unmodifiableList(cookies));
      } finally { connection.disconnect(); }
    }
  }
}
