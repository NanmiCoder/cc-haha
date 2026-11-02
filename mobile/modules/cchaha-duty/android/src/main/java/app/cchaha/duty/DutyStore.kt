package app.cchaha.duty

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One computer the service pulls from; mirrors `DutyHost` in `src/state/backgroundDuty.ts`. */
internal data class DutyHost(
  val hostId: String,
  val hostName: String,
  val origin: String,
  val headers: Map<String, String>,
  val token: String
)

/**
 * The host list survives process death and reboots so the service can restart on
 * its own. It holds connection credentials, so it is sealed with a Keystore key,
 * like the app's SecureStore entries. Every change is a read-modify-write under
 * one lock: the app and the service's own threads both edit it.
 */
internal object DutyStore {
  private const val PREFS = "cchaha_duty"
  private const val CONFIG = "config"
  private const val KEY_ALIAS = "cchaha_duty_config"

  fun host(item: JSONObject): DutyHost? {
    val origin = item.optString("origin")
    val token = item.optString("token")
    val hostId = item.optString("hostId")
    if (hostId.isEmpty() || token.isEmpty() || !(origin.startsWith("http://") || origin.startsWith("https://"))) return null
    val headers = mutableMapOf<String, String>()
    item.optJSONObject("headers")?.let { values ->
      values.keys().forEach { key -> headers[key] = values.optString(key) }
    }
    return DutyHost(hostId, item.optString("hostName").ifEmpty { "电脑" }, origin.trimEnd('/'), headers, token)
  }

  @Synchronized
  fun update(context: Context, change: (List<DutyHost>) -> List<DutyHost>): List<DutyHost> {
    val next = change(load(context))
    save(context, next)
    return next
  }

  @Synchronized
  fun load(context: Context): List<DutyHost> {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val stored = prefs.getString(CONFIG, null) ?: return emptyList()
    return try {
      val sealed = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
      val hosts = JSONArray(String(cipher.doFinal(sealed, 12, sealed.size - 12), Charsets.UTF_8))
      (0 until hosts.length()).mapNotNull { index -> hosts.optJSONObject(index)?.let(::host) }
    } catch (_: Exception) {
      // A lost key (restore to another device) cannot be repaired here; the app registers again.
      prefs.edit().remove(CONFIG).apply()
      emptyList()
    }
  }

  private fun save(context: Context, hosts: List<DutyHost>) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (hosts.isEmpty()) {
      prefs.edit().remove(CONFIG).apply()
      return
    }
    val json = JSONArray(hosts.map { host ->
      JSONObject().put("hostId", host.hostId).put("hostName", host.hostName).put("origin", host.origin)
        .put("headers", JSONObject(host.headers)).put("token", host.token)
    }).toString()
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.iv + cipher.doFinal(json.toByteArray(Charsets.UTF_8))
    prefs.edit().putString(CONFIG, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
  }

  private fun key(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }
}
