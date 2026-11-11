package com.cchaha.mobile;

import org.junit.Test;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class ReconnectClientTest {
  private static final String A = "https://old.test", B = "https://new.test";
  private static final long NOW = 1800000000000L;
  static class Host implements NativeTransport {
    final ProtocolFixture fixture;
    final List<String> requests = new ArrayList<>();
    boolean oldOffline, evil, revoked, wrongCookie, expired, badNonce, badSignature, wrongOrigin, sessionBadSignature;
    long sequence = 2;
    String directoryOrigin = B;
    Host() throws Exception { fixture = new ProtocolFixture(); }
    NativeTransport.Reply reply(JSONObject body) { return new NativeTransport.Reply(200, body, List.of()); }
    @Override public NativeTransport.Reply request(String origin, String path, JSONObject input, String cookie) throws Exception {
      requests.add(origin + path + (cookie == null ? ":anonymous" : ":cookie"));
      if (origin.equals(A) && oldOffline) throw new java.io.IOException("offline");
      if (path.startsWith("/v1/hosts/")) {
        assertNull(cookie); assertNull(input);
        long expiry = NOW + 600000;
        return reply(new JSONObject().put("version", 2).put("hostId", fixture.hostId).put("publicKey", fixture.publicKey).put("origin", directoryOrigin).put("sequence", sequence).put("expiresAt", expiry)
            .put("signature", fixture.signed("announce", fixture.hostId, directoryOrigin, Long.toString(sequence), Long.toString(expiry))));
      }
      if (path.endsWith("native/challenge")) {
        assertNull("The first contact can never carry a cookie", cookie);
        String nonce = badNonce ? RemoteProtocol.nonce() : input.getString("nonce"), challenge = RemoteProtocol.nonce();
        long expiry = NOW + (expired ? -1 : 60000);
        String endpoint = wrongOrigin ? "https://different.test" : origin;
        JSONObject output = new JSONObject().put("version", 2).put("hostId", fixture.hostId).put("publicKey", fixture.publicKey)
            .put("origin", endpoint).put("nonce", nonce).put("challenge", challenge).put("expiresAt", expiry)
            .put("signature", fixture.signed("host-proof", fixture.hostId, endpoint, nonce, challenge, Long.toString(expiry)));
        if (evil || badSignature) output.put("signature", RemoteProtocol.encode(new byte[256]));
        return reply(output);
      }
      if (path.endsWith("native/enroll")) {
        assertEquals("old-cookie", cookie);
        RemoteProtocol.verify(fixture.publicKey, input.getString("signature"), "enroll", fixture.hostId, origin, input.getString("devicePublicKey"), input.getString("nonce"));
        String id = RemoteProtocol.encode(new byte[32]);
        return reply(new JSONObject().put("hostId", fixture.hostId).put("origin", origin).put("deviceId", id).put("devicePublicKey", fixture.publicKey).put("nonce", input.getString("nonce"))
            .put("signature", fixture.signed("enrolled", fixture.hostId, origin, id, fixture.publicKey, input.getString("nonce"))));
      }
      if (path.endsWith("native/session")) {
        assertNull("Resume is a signed one-time proof, never an old cookie", cookie);
        if (revoked) return new NativeTransport.Reply(401, new JSONObject(), List.of());
        RemoteProtocol.verify(fixture.publicKey, input.getString("signature"), "resume", fixture.hostId, origin, input.getString("deviceId"), input.getString("nonce"), input.getString("challenge"), input.get("expiresAt").toString());
        String token = RemoteProtocol.nonce(), hash = RemoteProtocol.hashText(token); long expiry = NOW + 900000;
        JSONObject output = new JSONObject().put("version", 2).put("hostId", fixture.hostId).put("origin", origin).put("deviceId", input.getString("deviceId"))
            .put("nonce", input.getString("nonce")).put("tokenHash", hash).put("expiresAt", expiry)
            .put("signature", fixture.signed("session", fixture.hostId, origin, input.getString("deviceId"), input.getString("nonce"), hash, Long.toString(expiry)));
        if (sessionBadSignature) output.put("signature", RemoteProtocol.encode(new byte[256]));
        return new NativeTransport.Reply(200, output, List.of("__Host-haha-remote=" + (wrongCookie ? RemoteProtocol.nonce() : token) + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900"));
      }
      assertTrue(path.endsWith("/session"));
      return reply(new JSONObject().put("authenticated", cookie != null && !revoked).put("hostName", "Fixture Mac"));
    }
    ReconnectClient client() { return new ReconnectClient(this, fixture, () -> NOW); }
  }

  @Test public void healthySavedOriginUsesFreshProofThenExistingSessionWithoutDirectoryOrCookieRotation() throws Exception {
    Host host = new Host();
    ReconnectClient.Result result = host.client().connect(host.fixture.record(A, true), "old-cookie");
    assertEquals(SessionProbe.State.ONLINE, result.state);
    assertEquals(A, result.origin);
    assertNull(result.cookie);
    assertEquals(0, host.fixture.signatures);
    assertEquals(List.of(A + "/api/public-access/native/challenge:anonymous", A + "/api/public-access/session:cookie"), host.requests);
  }
  @Test public void staleDirectoryDoesNotDoubleTheTimeoutAgainstTheSameFailedOrigin() throws Exception {
    Host host = new Host(); host.oldOffline = true; host.directoryOrigin = A;
    ReconnectClient.Result result = host.client().connect(host.fixture.record(A, true), "old-cookie");
    assertEquals(SessionProbe.State.OFFLINE, result.state);
    assertEquals(2, host.requests.size());
    assertEquals(1, host.requests.stream().filter(request -> request.startsWith(A)).count());
    assertTrue(host.requests.stream().allMatch(request -> request.endsWith(":anonymous")));
    assertEquals(0, host.fixture.signatures);
  }

  @Test public void authorizesKeyOnlyAfterVerifiedHostAndExistingH5Approval() throws Exception {
    Host host = new Host();
    ReconnectClient.Result pending = host.client().connect(host.fixture.record(A, false), null);
    assertEquals(SessionProbe.State.UNPAIRED, pending.state);
    assertEquals(0, host.fixture.signatures);
    ReconnectClient.Result result = host.client().connect(host.fixture.record(A, false), "old-cookie");
    assertEquals(SessionProbe.State.ONLINE, result.state);
    assertNotNull(result.deviceId);
    assertEquals("Fixture Mac", result.hostName);
    assertNull(result.cookie);
  }
  @Test public void restoresNewAddressFromSignedDirectoryWithoutTransferringCookie() throws Exception {
    Host host = new Host(); host.oldOffline = true;
    ReconnectClient.Result result = host.client().connect(host.fixture.record(A, true), "old-cookie");
    assertEquals(SessionProbe.State.ONLINE, result.state);
    assertEquals(B, result.origin); assertEquals(2, result.sequence); assertNotNull(result.cookie);
    assertFalse(host.requests.stream().anyMatch(value -> value.startsWith(B) && value.endsWith(":cookie")));
    assertEquals(1, host.fixture.signatures);
  }
  @Test public void attackerAtSignedCandidateReceivesNeitherCookieNorDeviceSignature() throws Exception {
    Host host = new Host(); host.oldOffline = true; host.evil = true;
    ReconnectClient.Result result = host.client().connect(host.fixture.record(A, true), "old-cookie");
    assertEquals(SessionProbe.State.IDENTITY_FAILED, result.state);
    assertEquals(0, host.fixture.signatures);
    assertTrue(host.requests.stream().allMatch(value -> value.endsWith(":anonymous")));
  }
  @Test public void rejectsNonceOriginExpiryAndSignatureBeforeUsingStoredCookie() throws Exception {
    for (String failure : List.of("nonce", "origin", "expiry", "signature")) {
      Host host = new Host();
      host.badNonce = failure.equals("nonce"); host.wrongOrigin = failure.equals("origin"); host.expired = failure.equals("expiry"); host.badSignature = failure.equals("signature");
      assertEquals(failure, SessionProbe.State.IDENTITY_FAILED, host.client().connect(host.fixture.record(A, true), "old-cookie").state);
      assertEquals(0, host.fixture.signatures);
      assertTrue(host.requests.stream().allMatch(value -> value.endsWith(":anonymous")));
    }
  }
  @Test public void rejectsDirectoryRollbackWithoutContactingCandidate() throws Exception {
    Host host = new Host(); host.oldOffline = true; host.sequence = 1;
    JSONObject record = host.fixture.record(A, true).put("sequence", 2);
    assertEquals(SessionProbe.State.IDENTITY_FAILED, host.client().connect(record, null).state);
    assertFalse(host.requests.stream().anyMatch(value -> value.startsWith(B)));
  }
  @Test public void missingKeyAndRevokedAuthorizationRequireNewPairing() throws Exception {
    Host host = new Host(); host.fixture.exists = false;
    assertEquals(SessionProbe.State.PAIR_REQUIRED, host.client().connect(host.fixture.record(A, true), "old-cookie").state);
    assertEquals(0, host.fixture.signatures);
    host.fixture.exists = true; host.revoked = true;
    assertEquals(SessionProbe.State.PAIR_REQUIRED, host.client().connect(host.fixture.record(A, true), null).state);
    JSONObject rescan = host.fixture.record(A, true).put("nativePairing", true);
    assertEquals(SessionProbe.State.UNPAIRED, host.client().connect(rescan, null).state);
  }
  @Test public void sessionMustHaveBothHostSignatureAndMatchingCookieHash() throws Exception {
    for (boolean corruptHash : List.of(true, false)) {
      Host host = new Host(); host.wrongCookie = corruptHash; host.sessionBadSignature = !corruptHash;
      assertEquals(SessionProbe.State.IDENTITY_FAILED, host.client().connect(host.fixture.record(A, true), null).state);
    }
  }
  @Test public void legacyRecordsNeverSendRequestsOrCredentials() throws Exception {
    Host host = new Host();
    assertEquals(SessionProbe.State.LEGACY, host.client().connect(new JSONObject().put("origin", A), "old-cookie").state);
    assertTrue(host.requests.isEmpty());
  }
  @Test public void cookieParserRejectsUnsignedExtendedLifetime() {
    String token = RemoteProtocol.nonce();
    assertThrows(IllegalArgumentException.class, () -> ReconnectClient.verifiedCookie(List.of("__Host-haha-remote=" + token + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86401"), RemoteProtocol.hashText(token)));
  }
  @Test public void cookieParserRejectsDomainDuplicateFlagsAndMissingHttpOnly() {
    String token = RemoteProtocol.nonce(), prefix = "__Host-haha-remote=" + token;
    for (String suffix : List.of("; Path=/; Secure; SameSite=Strict", "; Path=/; Secure; HttpOnly; SameSite=Strict; Domain=evil.test", "; Path=/; Secure; HttpOnly; SameSite=Strict; Path=/evil"))
      assertThrows(IllegalArgumentException.class, () -> ReconnectClient.verifiedCookie(List.of(prefix + suffix), RemoteProtocol.hashText(token)));
  }
}
