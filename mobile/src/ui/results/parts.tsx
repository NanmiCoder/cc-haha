import React from 'react'
import { Pressable, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { Text } from '../Text'
import {
  Chevron,
  DiffStat,
  FileBadge,
  Icon,
  Mono,
  NavBar,
  ScreenView,
  useColors,
  type FileStatus,
} from '../kit'
import { splitPath } from '../../core/changesView'
import { plural } from '../../core/plural'

/** Changed file row: status badge · file name / directory · line stats · chevron. Shared by the changes page and the changes tab of project files. */
export function FileChangeRow({
  path,
  status,
  added,
  removed,
  detail,
  onPress,
}: {
  path: string
  status?: FileStatus
  added?: number
  removed?: number
  detail?: string
  onPress(): void
}) {
  const colors = useColors()
  const { name, dir } = splitPath(path)
  const stats = [added ? `${plural(added, 'line')} added` : '', removed ? `${plural(removed, 'line')} deleted` : '']
    .filter(Boolean)
    .join(', ')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[path, detail, stats].filter(Boolean).join(', ')}
      accessibilityHint="View diff"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 58,
        paddingHorizontal: 14,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? colors.fill : undefined,
      })}
    >
      {status ? <FileBadge status={status} /> : <View style={{ width: 22, height: 22 }} />}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Mono
          numberOfLines={1}
          style={{ fontSize: 14, lineHeight: 19, fontWeight: '500', color: colors.ink }}
        >
          {name}
        </Mono>
        {dir || detail ? (
          <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
            {dir ? <Mono style={{ fontSize: 12, color: colors.ink3 }}>{dir}</Mono> : null}
            {dir && detail ? ' · ' : null}
            {detail}
          </Text>
        ) : null}
      </View>
      <DiffStat added={added} removed={removed} size={12.5} />
      <Chevron />
    </Pressable>
  )
}

/** Solid folder (lucide folder outline filled), colored faint. */
export function FolderGlyph({ size = 20, color }: { size?: number; color?: string }) {
  const colors = useColors()
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill={color ?? colors.faint}
        d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
      />
    </Svg>
  )
}

/** Directory browse row: folders have a chevron; files may have a change badge and size on the right. */
export function TreeRow({
  name,
  directory,
  image,
  badge,
  size,
  onPress,
}: {
  name: string
  directory: boolean
  image?: boolean
  badge?: FileStatus
  size?: string
  onPress(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${directory ? 'Folder' : image ? 'Image' : 'Files'}`}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 50,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? colors.fill : undefined,
      })}
    >
      {directory ? (
        <FolderGlyph />
      ) : (
        <Icon name={image ? 'image' : 'file'} size={20} color={colors.ink3} strokeWidth={1.6} />
      )}
      <Mono numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: colors.ink }}>
        {name}
      </Mono>
      {badge ? <FileBadge status={badge} size={18} /> : null}
      {size ? (
        <Mono style={{ fontSize: 12.5, color: colors.ink3, minWidth: 44, textAlign: 'right' }}>
          {size}
        </Mono>
      ) : null}
      {directory ? <Chevron /> : null}
    </Pressable>
  )
}

/** White reading page (diffs, file preview): material header up to the status bar, white body, with an optional toolbar at the bottom. */
export function ReaderScreen({
  title,
  subtitle,
  right,
  footer,
  children,
}: React.PropsWithChildren<{
  title: string
  subtitle?: React.ReactNode
  right?: React.ReactNode
  footer?: React.ReactNode
}>) {
  const colors = useColors()
  return (
    <ScreenView background={colors.bar}>
      <NavBar
        title={title}
        titleMono
        subtitle={subtitle}
        right={right}
        bordered
        background={colors.bar}
      />
      <View style={{ flex: 1, backgroundColor: colors.card }}>{children}</View>
      {footer}
    </ScreenView>
  )
}

/** A subtitle line on reading pages: 12/16 ink3, content may mix monospace segments. */
export function SubtitleLine({ children }: React.PropsWithChildren) {
  const colors = useColors()
  return (
    <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
      {children}
    </Text>
  )
}
