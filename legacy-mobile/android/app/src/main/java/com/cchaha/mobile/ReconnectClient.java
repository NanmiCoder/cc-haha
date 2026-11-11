package com.cchaha.mobile;

import java.util.List;
import java.util.Locale;
import org.json.JSONObject;

/** The only path that may authenticate a discovered endpoint. All decisions are testable off-device. */
public final class ReconnectClient {
  public interface Keys {
    boolean exists(String alias) throws Exception;
    String ensurePublicKey(String alias) throws Exception;
    String sign(String alias, String purpose, String... fields) throws Exception;
    void delete(String alias) throws Exception;
  }
  public interface Clock { long now(); }
  public static final class Result {
    public final SessionProbe.State state;
    public final String origin, deviceId, cookie, hostName;
    public final long sequence;
    Result(SessionProbe.State state, String origin, long sequence, String deviceId, String cookie, String name) {
      this.state = state; this.origin = origin; this.sequence = sequence; this.deviceId = deviceId; this.cookie = cookie; this.hostName = name;
    }
  }
  private static final String API = "/api/public-access/";
  private final NativeTransport transport;
  private final Keys keys;
  private final Clock clock;
  public ReconnectClient(NativeTransport transport, Keys keys, Clock clock) { this.transport = transport; this.keys = keys; this.clock = clock; }
  private static final class IdentityFailure extends Exception { }
  private static final class Unavailable extends Exception { }
  private static final class Challenge {
    final String nonce, challenge;
    final long expiresAt;
    Challenge(String nonce, String challenge, long expiresAt) { this.nonce = nonce; this.challenge = challenge; this.expiresAt = expiresAt; }
  }

  public Result connect(JSONObject record, String currentOriginCookie) {
    String origin = record.optString("origin"); long sequence = record.optLong("sequence", 0);
    if (!ComputerRecords.isBound(record)) return result(SessionProbe.State.LEGACY, origin, sequence, null, null, null);
    boolean identityFailure = false;
    try { return atOrigin(record, origin, sequence, currentOriginCookie); }
    catch (IdentityFailure e) { identityFailure = true; }
    catch (Exception e) { /* The remembered endpoint may be offline or replaced. */ }
    try {
      NativeTransport.Reply directory = transport.request(record.getString("directory"), "/v1/hosts/" + record.getString("hostId"), null, null);
      if (directory.status != 200) throw new Unavailable();
      JSONObject announcement = directory.body;
      try {
        RemoteProtocol.version(announcement);
        RemoteProtocol.equal(record.getString("hostId"), RemoteProtocol.string(announcement, "hostId"));
        RemoteProtocol.equal(record.getString("hostKey"), RemoteProtocol.string(announcement, "publicKey"));
        String candidate = RemoteProtocol.string(announcement, "origin");
        RemoteProtocol.equal(candidate, RemoteUrl.requireOrigin(candidate));
        long nextSequence = RemoteProtocol.integer(announcement, "sequence");
        long expiry = RemoteProtocol.integer(announcement, "expiresAt");
        RemoteProtocol.expiry(expiry, clock.now(), 600000);
        if (nextSequence < sequence || (nextSequence == sequence && !candidate.equals(origin))) throw new IllegalArgumentException("directory_rollback");
        RemoteProtocol.verify(record.getString("hostKey"), RemoteProtocol.string(announcement, "signature"), "announce",
            record.getString("hostId"), candidate, Long.toString(nextSequence), Long.toString(expiry));
        // A stale directory entry cannot make a failed endpoint healthier.
        // Retrying that same origin here doubled the offline cold-start timeout.
        if (candidate.equals(origin)) throw new Unavailable();
        // No cookie from the previous origin accompanies discovery or this proof.
        return atOrigin(record, candidate, nextSequence, null);
      } catch (IllegalArgumentException e) { throw new IdentityFailure(); }
    } catch (IdentityFailure e) { identityFailure = true; }
    catch (Exception e) { /* A directory outage is not a revoked pairing. */ }
    return result(identityFailure ? SessionProbe.State.IDENTITY_FAILED : SessionProbe.State.OFFLINE, origin, sequence, null, null, null);
  }

  private Challenge prove(JSONObject record, String origin) throws Exception {
    String nonce = RemoteProtocol.nonce();
    NativeTransport.Reply reply = transport.request(origin, API + "native/challenge",
        new JSONObject().put("nonce", nonce).put("hostId", record.getString("hostId")), null);
    if (reply.status != 200) throw new Unavailable();
    try {
      JSONObject body = reply.body;
      RemoteProtocol.version(body);
      RemoteProtocol.equal(record.getString("hostId"), RemoteProtocol.string(body, "hostId"));
      RemoteProtocol.equal(record.getString("hostKey"), RemoteProtocol.string(body, "publicKey"));
      RemoteProtocol.equal(origin, RemoteProtocol.string(body, "origin"));
      RemoteProtocol.equal(nonce, RemoteProtocol.string(body, "nonce"));
      String challenge = RemoteProtocol.string(body, "challenge");
      if (!RemoteProtocol.isNonce(challenge)) throw new IllegalArgumentException("invalid_challenge");
      long expiry = RemoteProtocol.integer(body, "expiresAt");
      RemoteProtocol.expiry(expiry, clock.now(), 60000);
      RemoteProtocol.verify(record.getString("hostKey"), RemoteProtocol.string(body, "signature"), "host-proof",
          record.getString("hostId"), origin, nonce, challenge, Long.toString(expiry));
      return new Challenge(nonce, challenge, expiry);
    } catch (Exception e) { throw new IdentityFailure(); }
  }

  private Result atOrigin(JSONObject record, String origin, long sequence, String cookie) throws Exception {
    Challenge challenge = prove(record, origin);
    String hostId = record.getString("hostId"), alias = record.getString("keyAlias");
    String deviceId = record.optString("deviceId", "");
    if (!deviceId.isEmpty() && !keys.exists(alias)) return result(record.optBoolean("nativePairing") ? SessionProbe.State.UNPAIRED : SessionProbe.State.PAIR_REQUIRED, origin, sequence, deviceId, null, null);
    // The old cookie is used only after fresh proof of this exact endpoint.
    if (cookie != null && !cookie.isEmpty()) {
      NativeTransport.Reply session = transport.request(origin, API + "session", null, cookie);
      if (session.status == 200 && Boolean.TRUE.equals(session.body.opt("authenticated"))) {
        String name = session.body.optString("hostName", null);
        if (!deviceId.isEmpty()) return result(SessionProbe.State.ONLINE, origin, sequence, deviceId, null, name);
        String publicKey = keys.ensurePublicKey(alias), nonce = RemoteProtocol.nonce();
        String signature = keys.sign(alias, "enroll", hostId, origin, publicKey, nonce);
        NativeTransport.Reply enrolled = transport.request(origin, API + "native/enroll",
            new JSONObject().put("devicePublicKey", publicKey).put("nonce", nonce).put("signature", signature), cookie);
        if (enrolled.status == 401 || enrolled.status == 403 || enrolled.status == 409) return result(record.optBoolean("nativePairing") ? SessionProbe.State.UNPAIRED : SessionProbe.State.PAIR_REQUIRED, origin, sequence, null, null, name);
        if (enrolled.status != 200) throw new Unavailable();
        try {
          JSONObject body = enrolled.body;
          RemoteProtocol.equal(hostId, RemoteProtocol.string(body, "hostId"));
          RemoteProtocol.equal(origin, RemoteProtocol.string(body, "origin"));
          RemoteProtocol.equal(publicKey, RemoteProtocol.string(body, "devicePublicKey"));
          RemoteProtocol.equal(nonce, RemoteProtocol.string(body, "nonce"));
          deviceId = RemoteProtocol.string(body, "deviceId");
          if (!RemoteProtocol.isNonce(deviceId)) throw new IllegalArgumentException("invalid_device");
          RemoteProtocol.verify(record.getString("hostKey"), RemoteProtocol.string(body, "signature"), "enrolled", hostId, origin, deviceId, publicKey, nonce);
          return result(SessionProbe.State.ONLINE, origin, sequence, deviceId, null, name);
        } catch (Exception e) { throw new IdentityFailure(); }
      }
      if (session.status >= 500 || session.status == 429) throw new Unavailable();
    }
    if (deviceId.isEmpty()) return result(SessionProbe.State.UNPAIRED, origin, sequence, null, null, null);
    if (challenge.expiresAt <= clock.now()) challenge = prove(record, origin);
    String signed = keys.sign(alias, "resume", hostId, origin, deviceId, challenge.nonce, challenge.challenge, Long.toString(challenge.expiresAt));
    NativeTransport.Reply resumed = transport.request(origin, API + "native/session", new JSONObject()
        .put("hostId", hostId).put("deviceId", deviceId).put("nonce", challenge.nonce).put("challenge", challenge.challenge)
        .put("expiresAt", challenge.expiresAt).put("signature", signed), null);
    if (resumed.status == 401 || resumed.status == 403) return result(record.optBoolean("nativePairing") ? SessionProbe.State.UNPAIRED : SessionProbe.State.PAIR_REQUIRED, origin, sequence, deviceId, null, null);
    if (resumed.status != 200) throw new Unavailable();
    try {
      JSONObject body = resumed.body;
      RemoteProtocol.version(body);
      RemoteProtocol.equal(hostId, RemoteProtocol.string(body, "hostId"));
      RemoteProtocol.equal(origin, RemoteProtocol.string(body, "origin"));
      RemoteProtocol.equal(deviceId, RemoteProtocol.string(body, "deviceId"));
      RemoteProtocol.equal(challenge.nonce, RemoteProtocol.string(body, "nonce"));
      String tokenHash = RemoteProtocol.string(body, "tokenHash");
      if (!tokenHash.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("invalid_token");
      long expiresAt = RemoteProtocol.integer(body, "expiresAt");
      RemoteProtocol.expiry(expiresAt, clock.now(), 24L * 60 * 60000);
      RemoteProtocol.verify(record.getString("hostKey"), RemoteProtocol.string(body, "signature"), "session",
          hostId, origin, deviceId, challenge.nonce, tokenHash, Long.toString(expiresAt));
      String freshCookie = verifiedCookie(resumed.cookies, tokenHash);
      return result(SessionProbe.State.ONLINE, origin, sequence, deviceId, freshCookie, null);
    } catch (Exception e) { throw new IdentityFailure(); }
  }

  static String verifiedCookie(List<String> cookies, String hash) {
    if (cookies.size() != 1) throw new IllegalArgumentException("invalid_cookie");
    String header = cookies.get(0);
    if (header.length() > 4096 || header.matches("(?s).*[\\r\\n].*")) throw new IllegalArgumentException("invalid_cookie");
    String[] parts = header.split(";");
    String pair = parts[0].trim();
    if (!pair.startsWith("__Host-haha-remote=")) throw new IllegalArgumentException("invalid_cookie");
    String token = pair.substring("__Host-haha-remote=".length());
    if (!RemoteProtocol.isNonce(token)) throw new IllegalArgumentException("invalid_cookie");
    RemoteProtocol.equal(hash, RemoteProtocol.hashText(token));
    java.util.Map<String, String> flags = new java.util.HashMap<>();
    for (int i = 1; i < parts.length; i++) {
      String[] item = parts[i].trim().split("=", 2); String name = item[0].toLowerCase(Locale.ROOT);
      if (flags.put(name, item.length == 2 ? item[1] : "") != null) throw new IllegalArgumentException("duplicate_cookie_flag");
    }
    if (!"/".equals(flags.get("path")) || !flags.containsKey("secure") || !flags.containsKey("httponly")
        || !"strict".equalsIgnoreCase(flags.get("samesite")) || flags.containsKey("domain")) throw new IllegalArgumentException("unsafe_cookie");
    String age = flags.get("max-age");
    if (age == null || !age.matches("[0-9]{1,5}") || Long.parseLong(age) < 1 || Long.parseLong(age) > 86400) throw new IllegalArgumentException("unsafe_cookie_lifetime");
    return header;
  }
  private Result result(SessionProbe.State state, String origin, long sequence, String deviceId, String cookie, String name) {
    return new Result(state, origin, sequence, deviceId, cookie, name);
  }
}
