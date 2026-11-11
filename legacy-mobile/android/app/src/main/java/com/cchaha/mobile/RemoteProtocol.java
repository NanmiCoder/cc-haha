package com.cchaha.mobile;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import org.json.JSONObject;

/** Exact v2 wire encoding shared with the desktop; no Android or network state. */
public final class RemoteProtocol {
  private RemoteProtocol() { }
  public static String encode(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
  public static byte[] decode(String value) {
    if (value == null || value.length() > 4096 || !value.matches("[A-Za-z0-9_-]+")) throw new IllegalArgumentException("invalid_encoding");
    byte[] decoded = Base64.getUrlDecoder().decode(value);
    if (!encode(decoded).equals(value)) throw new IllegalArgumentException("invalid_encoding");
    return decoded;
  }
  public static String nonce() { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return encode(bytes); }
  public static boolean isNonce(String value) { try { return decode(value).length == 32; } catch (Exception e) { return false; } }
  public static String sha256(byte[] bytes) {
    try {
      StringBuilder result = new StringBuilder();
      for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
      return result.toString();
    } catch (Exception e) { throw new IllegalStateException("crypto_unavailable"); }
  }
  public static String hashText(String value) { return sha256(value.getBytes(StandardCharsets.UTF_8)); }
  public static PublicKey publicKey(String encoded) {
    try {
      byte[] bytes = decode(encoded);
      PublicKey key = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(bytes));
      if (!(key instanceof RSAPublicKey) || ((RSAPublicKey) key).getModulus().bitLength() != 2048
          || !MessageDigest.isEqual(bytes, key.getEncoded())) throw new IllegalArgumentException("invalid_public_key");
      return key;
    } catch (Exception e) { throw new IllegalArgumentException("invalid_public_key"); }
  }
  public static String hostId(String publicKey) { return sha256(publicKey(publicKey).getEncoded()); }
  public static byte[] canonical(String purpose, String... fields) {
    StringBuilder value = new StringBuilder("cc-haha-remote-v2").append('\n').append(field(purpose));
    for (String item : fields) value.append('\n').append(field(item));
    return value.toString().getBytes(StandardCharsets.UTF_8);
  }
  private static String field(String value) {
    if (value == null || value.length() > 4096 || value.matches("(?s).*[\\p{Cntrl}].*")) throw new IllegalArgumentException("invalid_field");
    return value;
  }
  public static void verify(String key, String signature, String purpose, String... fields) {
    try {
      Signature verifier = Signature.getInstance("SHA256withRSA");
      verifier.initVerify(publicKey(key)); verifier.update(canonical(purpose, fields));
      byte[] bytes = decode(signature);
      if (bytes.length != 256 || !verifier.verify(bytes)) throw new IllegalArgumentException("identity_failed");
    } catch (Exception e) { throw new IllegalArgumentException("identity_failed"); }
  }
  public static String string(JSONObject object, String key) {
    Object value = object.opt(key);
    if (!(value instanceof String)) throw new IllegalArgumentException("invalid_response");
    return field((String) value);
  }
  public static long integer(JSONObject object, String key) {
    Object value = object.opt(key);
    if (!(value instanceof Number)) throw new IllegalArgumentException("invalid_response");
    double number = ((Number) value).doubleValue();
    if (!Double.isFinite(number) || number != Math.rint(number) || number < 0 || number > 9_007_199_254_740_991d) throw new IllegalArgumentException("invalid_response");
    return ((Number) value).longValue();
  }
  public static void version(JSONObject body) { if (integer(body, "version") != 2) throw new IllegalArgumentException("unsupported_protocol"); }
  public static void expiry(long expiry, long now, long maximum) {
    if (expiry <= now || expiry > now + maximum + 5000) throw new IllegalArgumentException("expired_proof");
  }
  public static void equal(String expected, String actual) {
    if (expected == null || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), actual.getBytes(StandardCharsets.UTF_8))) throw new IllegalArgumentException("identity_failed");
  }
}
