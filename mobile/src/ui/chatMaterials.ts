import { Platform } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import {
  FILE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  attachmentFromBase64,
  formatBytes,
  type ComposerAttachment,
} from '../core/chatComposer'

export async function pickChatMaterial(
  kind: 'camera' | 'photos' | 'file'
): Promise<ComposerAttachment[]> {
  if (kind === 'file') {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      base64: true,
    })
    if (result.canceled) return []
    return Promise.all(
      result.assets.map(async (asset) => {
        if ((asset.size ?? 0) > FILE_MAX_BYTES)
          throw new Error(`File exceeds ${formatBytes(FILE_MAX_BYTES)}; please split it before sending.`)
        // web the uri is a blob: address, with content in base64 (data URL).
        const base64 =
          Platform.OS === 'web'
            ? (asset.base64 ?? asset.uri)
            : await new File(asset.uri).base64()
        if (Platform.OS === 'web' && !base64.startsWith('data:'))
          throw new Error('The browser did not provide file content; please choose again.')
        return attachmentFromBase64({
          name: asset.name,
          mimeType: asset.mimeType ?? 'application/octet-stream',
          base64,
          uri: asset.uri,
        })
      })
    )
  }
  if (kind === 'camera' && Platform.OS !== 'web') {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted)
      throw new Error(
        'Camera permission is off. You can choose from the photo library, or allow cc-haha to use the camera in system settings.'
      )
  }
  const result =
    kind === 'camera'
      ? await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
          quality: 1,
          exif: false,
        })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          // Up to 10 at a time; you can keep adding in several rounds.
          selectionLimit: 10,
          quality: 1,
          exif: false,
        })
  if (result.canceled) return []
  return Promise.all(
    result.assets.map(async (asset) => {
      const context = ImageManipulator.manipulate(asset.uri)
      if (Math.max(asset.width, asset.height) > IMAGE_MAX_EDGE)
        context.resize(
          asset.width >= asset.height
            ? { width: IMAGE_MAX_EDGE }
            : { height: IMAGE_MAX_EDGE }
        )
      const rendered = await context.renderAsync()
      try {
        const result = await rendered.saveAsync({
          format: SaveFormat.JPEG,
          compress: 0.72,
          base64: true,
        })
        return attachmentFromBase64({
          name: `${(asset.fileName ?? 'Photos').replace(/\.[^.]+$/, '')}.jpg`,
          mimeType: 'image/jpeg',
          base64: result.base64 ?? '',
          uri: result.uri,
        })
      } finally {
        rendered.release()
        context.release()
      }
    })
  )
}
