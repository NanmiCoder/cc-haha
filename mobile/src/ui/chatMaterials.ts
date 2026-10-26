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
          throw new Error(`文件超过 ${formatBytes(FILE_MAX_BYTES)}，请拆分后发送。`)
        // web 端的 uri 是 blob: 地址，内容在 base64（data URL）里。
        const base64 =
          Platform.OS === 'web'
            ? (asset.base64 ?? asset.uri)
            : await new File(asset.uri).base64()
        if (Platform.OS === 'web' && !base64.startsWith('data:'))
          throw new Error('浏览器未提供文件内容，请重新选择。')
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
        '相机权限未开启。可以选择相册，或到系统设置允许 cc-haha 使用相机。'
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
          selectionLimit: 3,
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
          name: `${(asset.fileName ?? '照片').replace(/\.[^.]+$/, '')}.jpg`,
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
