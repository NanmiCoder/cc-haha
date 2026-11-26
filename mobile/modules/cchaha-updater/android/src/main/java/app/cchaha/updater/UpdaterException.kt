package app.cchaha.updater

import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

class UpdaterException(
  val code: String,
  override val message: String,
  cause: Throwable? = null,
) : Exception(message, cause)

internal fun mapNetworkException(error: Throwable, cancelled: Boolean): UpdaterException {
  if (cancelled) return UpdaterException("CANCELLED", "Download cancelled", error)
  if (error is UpdaterException) return error
  return when (error) {
    is SocketTimeoutException -> UpdaterException("TIMEOUT", "Request timed out", error)
    is InterruptedIOException -> UpdaterException("TIMEOUT", "Connection timed out", error)
    is UnknownHostException -> UpdaterException("NETWORK_ERROR", "Unable to resolve host", error)
    is SSLException -> UpdaterException("TLS_ERROR", "TLS handshake failed", error)
    else -> UpdaterException("NETWORK_ERROR", error.message ?: "Network error", error)
  }
}
