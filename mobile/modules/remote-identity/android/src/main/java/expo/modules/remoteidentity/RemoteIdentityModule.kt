package expo.modules.remoteidentity

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.net.ConnectivityManager
import android.net.Network
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.security.spec.X509EncodedKeySpec

/** The v2 protocol uses RSA-2048/SHA256. No private-key export API exists. */
class RemoteIdentityModule : Module() {
  private val lock = Any()
  private var connectivity: ConnectivityManager? = null
  private var lastNetwork: Network? = null
  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
      synchronized(lock) {
        if (lastNetwork == network) return
        lastNetwork = network
        sendEvent("networkChanged", emptyMap<String, Any>())
      }
    }
    override fun onLost(network: Network) {
      synchronized(lock) {
        if (lastNetwork != network) return
        lastNetwork = null
        sendEvent("networkChanged", emptyMap<String, Any>())
      }
    }
  }
  private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private fun alias(value: String): String {
    require(Regex("cc-haha\\.remote\\.[A-Za-z0-9_-]{1,100}").matches(value))
    return value
  }
  private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  private fun decode(value: String): ByteArray {
    require(value.length <= 4096 && Regex("[A-Za-z0-9_-]+").matches(value))
    val bytes = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    require(encode(bytes) == value)
    return bytes
  }
  private fun publicKey(value: String): RSAPublicKey {
    val bytes = decode(value)
    val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(bytes)) as RSAPublicKey
    require(key.modulus.bitLength() == 2048 && MessageDigest.isEqual(bytes, key.encoded))
    return key
  }
  private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
  private fun canonical(purpose: String, fields: List<String>): ByteArray {
    require((listOf(purpose) + fields).all { it.length <= 4096 && it.none { ch -> ch.code < 32 || ch.code == 127 } })
    return (listOf("cc-haha-remote-v2", purpose) + fields).joinToString("\n").toByteArray(Charsets.UTF_8)
  }

  override fun definition() = ModuleDefinition {
    Name("RemoteIdentity")
    Events("networkChanged")
    OnStartObserving {
      synchronized(lock) {
        connectivity = appContext.reactContext?.getSystemService(ConnectivityManager::class.java)
        lastNetwork = connectivity?.activeNetwork
        connectivity?.registerDefaultNetworkCallback(networkCallback)
      }
    }
    OnStopObserving {
      synchronized(lock) {
        connectivity?.unregisterNetworkCallback(networkCallback)
        connectivity = null
        lastNetwork = null
      }
    }
    AsyncFunction("hostId") { key: String -> hash(publicKey(key).encoded) }
    AsyncFunction("nonce") { encode(ByteArray(32).also { SecureRandom().nextBytes(it) }) }
    AsyncFunction("hashText") { value: String -> hash(value.toByteArray(Charsets.UTF_8)) }
    AsyncFunction("exists") { value: String -> synchronized(lock) { store().containsAlias(alias(value)) } }
    AsyncFunction("ensurePublicKey") { value: String ->
      synchronized(lock) {
        val name = alias(value)
        if (!store().containsAlias(name)) {
          val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore")
          generator.initialize(KeyGenParameterSpec.Builder(name, KeyProperties.PURPOSE_SIGN)
            .setKeySize(2048).setDigests(KeyProperties.DIGEST_SHA256)
            .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
            .setUserAuthenticationRequired(false).build())
          generator.generateKeyPair()
        }
        encode(store().getCertificate(name).publicKey.encoded)
      }
    }
    AsyncFunction("sign") { value: String, purpose: String, fields: List<String> ->
      synchronized(lock) {
        val key = store().getKey(alias(value), null) as? PrivateKey ?: error("device_key_missing")
        val signer = Signature.getInstance("SHA256withRSA")
        signer.initSign(key)
        signer.update(canonical(purpose, fields))
        encode(signer.sign())
      }
    }
    AsyncFunction("verify") { key: String, signature: String, purpose: String, fields: List<String> ->
      val verifier = Signature.getInstance("SHA256withRSA")
      verifier.initVerify(publicKey(key))
      verifier.update(canonical(purpose, fields))
      val bytes = decode(signature)
      bytes.size == 256 && verifier.verify(bytes)
    }
    AsyncFunction("remove") { value: String -> synchronized(lock) { store().deleteEntry(alias(value)) } }
  }
}
