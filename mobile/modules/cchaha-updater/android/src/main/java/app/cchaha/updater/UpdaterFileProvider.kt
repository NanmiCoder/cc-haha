package app.cchaha.updater

import androidx.core.content.FileProvider

/**
 * Dedicated FileProvider for APK updates so Gradle manifest merging never
 * collides with expo-sharing, expo-file-system, or expo-image-picker.
 */
class UpdaterFileProvider : FileProvider()
