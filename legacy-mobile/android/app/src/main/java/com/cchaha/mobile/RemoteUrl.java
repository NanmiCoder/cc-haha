package com.cchaha.mobile;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** QR trust material remains native; only the one-time pair value reaches H5. */
public final class RemoteUrl {
  public final String origin;
  public final String launchUrl;
  public final boolean pairing;
  public final String hostKey;
  public final String hostId;
  public final String directory;

  private RemoteUrl(String origin, String pair, String key, String directory) {
    this.origin = origin; this.pairing = pair != null;
    this.hostKey = key; this.hostId = key == null ? null : RemoteProtocol.hostId(key); this.directory = directory;
    this.launchUrl = origin + "/remote" + (pair == null ? "" : "#pair=" + pair);
  }
  public static RemoteUrl parse(String input) {
    try {
      URI uri = secureUri(input.trim());
      if (!("/remote".equals(uri.getRawPath()) || "/remote/".equals(uri.getRawPath())) || uri.getRawQuery() != null) throw new IllegalArgumentException("remote_path_required");
      String raw = uri.getRawFragment();
      if (raw == null) return new RemoteUrl(originOf(uri), null, null, null);
      Map<String, String> fields = new LinkedHashMap<>();
      for (String item : raw.split("&", -1)) {
        int at = item.indexOf('=');
        if (at < 1) throw new IllegalArgumentException("invalid_pairing");
        String key = URLDecoder.decode(item.substring(0, at), "UTF-8");
        String value = URLDecoder.decode(item.substring(at + 1), "UTF-8");
        if (fields.put(key, value) != null) throw new IllegalArgumentException("duplicate_field");
      }
      String pair = fields.get("pair");
      if (pair == null || !pair.matches("[A-Za-z0-9_-]{16,256}")) throw new IllegalArgumentException("invalid_pairing");
      if (fields.size() == 1) return new RemoteUrl(originOf(uri), pair, null, null);
      if (fields.size() != 4 || !"2".equals(fields.get("v")) || !fields.containsKey("hostKey") || !fields.containsKey("directory")) throw new IllegalArgumentException("unsupported_pairing");
      String directory = requireOrigin(fields.get("directory"));
      return new RemoteUrl(originOf(uri), pair, fields.get("hostKey"), directory);
    } catch (NullPointerException | URISyntaxException | java.io.UnsupportedEncodingException error) { throw new IllegalArgumentException("invalid_url"); }
  }
  static URI secureUri(String input) throws URISyntaxException {
    if (input.length() > 4096 || input.matches("(?s).*[\\\\\\s\\p{Cntrl}].*")) throw new IllegalArgumentException("invalid_url");
    URI uri = new URI(input);
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
        || uri.getPort() == 0 || uri.getPort() > 65535 || uri.getHost().endsWith(".")) throw new IllegalArgumentException("https_required");
    return uri;
  }
  public static String requireOrigin(String input) {
    try {
      URI uri = secureUri(input);
      if (!(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())) || uri.getRawQuery() != null || uri.getRawFragment() != null) throw new IllegalArgumentException("origin_required");
      return originOf(uri);
    } catch (Exception error) { throw new IllegalArgumentException("https_origin_required"); }
  }
  static String originOf(URI uri) {
    int port = uri.getPort();
    return "https://" + uri.getHost().toLowerCase(Locale.ROOT) + (port == -1 || port == 443 ? "" : ":" + port);
  }
  public String savedUrl() { return origin + "/remote"; }
  public boolean isTemporaryTunnel() { return URI.create(origin).getHost().endsWith(".trycloudflare.com"); }
}
