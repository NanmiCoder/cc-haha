package com.cchaha.mobile;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import org.json.JSONObject;

final class ProtocolFixture implements ReconnectClient.Keys {
  final JSONObject data;
  final String publicKey, hostId;
  final PrivateKey privateKey;
  boolean exists = true;
  int signatures;
  ProtocolFixture() throws Exception {
    try (var input = getClass().getResourceAsStream("/remote-identity-v2.json")) {
      data = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
    }
    publicKey = data.getString("publicKey"); hostId = data.getString("hostId");
    privateKey = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(RemoteProtocol.decode(data.getString("privateKeyPkcs8"))));
  }
  String qr(String origin) { return origin + "/remote#pair=abcdefghijklmnop&v=2&hostKey=" + publicKey + "&directory=https%3A%2F%2Fdirectory.test"; }
  JSONObject record(String origin, boolean enrolled) throws Exception {
    ComputerRecords store = new ComputerRecords("{}");
    JSONObject record = store.add(RemoteUrl.parse(qr(origin)), "Computer");
    if (enrolled) record.put("deviceId", RemoteProtocol.encode(new byte[32]));
    return record;
  }
  public boolean exists(String alias) { return exists; }
  public String ensurePublicKey(String alias) { exists = true; return publicKey; }
  public String sign(String alias, String purpose, String... fields) throws Exception { signatures++; return signed(purpose, fields); }
  String signed(String purpose, String... fields) throws Exception {
    Signature signer = Signature.getInstance("SHA256withRSA"); signer.initSign(privateKey); signer.update(RemoteProtocol.canonical(purpose, fields));
    return RemoteProtocol.encode(signer.sign());
  }
  public void delete(String alias) { exists = false; }
}
