package com.cchaha.mobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;

/** Private signing keys never leave Android Keystore or enter the record JSON. */
public final class DeviceKeys implements ReconnectClient.Keys {
  private KeyStore store() throws Exception { KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); return store; }
  @Override public boolean exists(String alias) throws Exception { return store().containsAlias(alias); }
  @Override public String ensurePublicKey(String alias) throws Exception {
    if (!exists(alias)) {
      KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
      generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
          .setKeySize(2048).setDigests(KeyProperties.DIGEST_SHA256)
          .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
          .setUserAuthenticationRequired(false).build());
      generator.generateKeyPair();
    }
    return RemoteProtocol.encode(store().getCertificate(alias).getPublicKey().getEncoded());
  }
  @Override public String sign(String alias, String purpose, String... fields) throws Exception {
    if (!exists(alias)) throw new IllegalStateException("device_key_missing");
    Signature signature = Signature.getInstance("SHA256withRSA");
    signature.initSign((PrivateKey) store().getKey(alias, null));
    signature.update(RemoteProtocol.canonical(purpose, fields));
    return RemoteProtocol.encode(signature.sign());
  }
  @Override public void delete(String alias) throws Exception { if (exists(alias)) store().deleteEntry(alias); }
}
