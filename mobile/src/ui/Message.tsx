import { memo, useMemo, useRef, useState, type ComponentRef } from 'react'
import { Image, Keyboard, Platform, Pressable, ScrollView, View, type TextStyle } from 'react-native'
import { Text } from './Text'
import type { ChatItem } from '../core/types'
import { visibleMessageText } from '../core/chatComposer'
import { userMessageDisplay, type UserMessageCapability } from '../core/userMessageDisplay'
import { Callout, CodeBlock, Icon, InlineCode, useColors } from './kit'
import {
  fitColumnWidths,
  MARKDOWN_EXPAND_LIMIT,
  MARKDOWN_LIMIT,
  naturalColumnWidths,
  parseInline,
  parseMarkdown,
  windowMarkdown,
  type MarkdownBlock,
  type MarkdownLimit,
} from './chat/markdown'
import { ImagePreview } from './chat/ImagePreview'
import { attachmentImageSelection, attachmentImageUri, type ImagePreviewSelection } from './chat/attachmentPreview'
import { Glyph } from './compose/glyphs'
import { plural } from '../core/plural'

function Inline({
  text,
  selectable,
  style,
}: {
  text: string
  selectable: boolean
  style: TextStyle
}) {
  return (
    <Text selectable={selectable} style={style}>
      {parseInline(text).map((segment, index) =>
        segment.type === 'code' ? (
          <InlineCode key={index}>{segment.text}</InlineCode>
        ) : segment.type === 'bold' ? (
          <Text key={index} style={{ fontWeight: '600' }}>
            {segment.text}
          </Text>
        ) : (
          segment.text
        )
      )}
    </Text>
  )
}

/**
 * Tables: distribute column widths by the container's available width so the whole table fills one screen; only when there are too many columns that do not fit even at the minimum readable width 
 * fall back to horizontal scrolling. Previously column widths were estimated from content only, and on narrow screens the header background and last column left a gap on the right, 
 * which looked truncated.
 */
function MarkdownTable({
  header,
  rows,
  selectable,
}: {
  header: string[]
  rows: string[][]
  selectable: boolean
}) {
  const colors = useColors()
  const [available, setAvailable] = useState(0)
  const natural = useMemo(() => naturalColumnWidths(header, rows), [header, rows])
  // ScrollView 1px border counts toward the layout width, so content only gets the width minus the border.
  const measured = available > 2
  const fitted = measured ? fitColumnWidths(natural, available - 2) : null
  const widths = fitted ?? natural
  // When width is not measured yet (0) render with natural column widths; when a degenerate width of 1–2px is measured still allow horizontal scrolling, 
  // otherwise content would overflow and be stuck.
  const scroll = measured ? fitted === null : available > 0
  const cell = (text: string, column: number, head: boolean, last: boolean) => (
    <View
      key={column}
      style={{
        width: widths[column],
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRightWidth: last ? 0 : 1,
        borderRightColor: colors.hair,
      }}
    >
      <Inline
        text={text}
        selectable={selectable}
        style={{ fontSize: 14, lineHeight: 20, color: colors.ink, ...(head ? { fontWeight: '600' } : {}) }}
      />
    </View>
  )
  return (
    <View
      style={{ width: '100%' }}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width)
        setAvailable((previous) => (previous === next ? previous : next))
      }}
    >
      <ScrollView
        horizontal
        scrollEnabled={scroll}
        showsHorizontalScrollIndicator={scroll}
        style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.hair, backgroundColor: colors.card }}
      >
        <View>
          <View style={{ flexDirection: 'row', backgroundColor: colors.fill }}>
            {header.map((title, column) => cell(title, column, true, column === header.length - 1))}
          </View>
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.hair }}>
              {row.map((text, column) => cell(text, column, false, column === row.length - 1))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

/**
 * Markdown rendering shared by assistant body and plan content (16/25, code blocks use CodeBlock).
 * Very long content mounts only the beginning and end (see windowMarkdown); tap the middle to expand in batches, up to
 * MARKDOWN_EXPAND_LIMIT; when expandable is false only an omission hint is shown.
 */
export function Markdown({
  text,
  selectable = true,
  limit = MARKDOWN_LIMIT,
  expandable = true,
}: {
  text: string
  selectable?: boolean
  limit?: MarkdownLimit
  expandable?: boolean
}) {
  const colors = useColors()
  const [extra, setExtra] = useState(0)
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const ceiling = Math.max(limit.head, MARKDOWN_EXPAND_LIMIT)
  const head = Math.min(limit.head + extra, ceiling)
  const shown = useMemo(
    () => windowMarkdown(blocks, { head, tail: limit.tail }),
    [blocks, head, limit.tail]
  )
  const body: TextStyle = { fontSize: 16, lineHeight: 25, color: colors.ink }
  const render = (block: MarkdownBlock, key: string) => {
    switch (block.type) {
      case 'code':
        return <CodeBlock key={key}>{block.text || ' '}</CodeBlock>
      case 'heading':
        return (
          <Inline
            key={key}
            text={block.text}
            selectable={selectable}
            style={{
              ...body,
              fontWeight: '600',
              ...(block.level <= 2 ? { fontSize: 18, lineHeight: 26 } : {}),
            }}
          />
        )
      case 'list':
        return (
          <View key={key} style={{ gap: 4, paddingLeft: 4 }}>
            {block.items.map((item, itemIndex) => (
              <View key={itemIndex} style={{ flexDirection: 'row', gap: 10 }}>
                <Text style={[body, { color: colors.ink3 }]}>{item.marker}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Inline text={item.text} selectable={selectable} style={body} />
                </View>
              </View>
            ))}
          </View>
        )
      case 'quote':
        return (
          <View
            key={key}
            style={{ borderLeftWidth: 3, borderLeftColor: colors.hair, paddingLeft: 12 }}
          >
            <Inline text={block.text} selectable={selectable} style={{ ...body, color: colors.ink2 }} />
          </View>
        )
      case 'table':
        return <MarkdownTable key={key} header={block.header} rows={block.rows} selectable={selectable} />
      case 'rule':
        return <View key={key} style={{ height: 1, backgroundColor: colors.hair }} />
      default:
        return <Inline key={key} text={block.text} selectable={selectable} style={body} />
    }
  }
  const omitted = `${plural(shown.hidden, 'more block')}${shown.tail.length ? ' in the middle' : ' after this'}`
  // The end window always ends with the last block; keys come from the block position in the source, so when streaming appends only the edges shift and the whole thing is not remounted.
  const tailStart = blocks.length - shown.tail.length
  return (
    <View style={{ gap: 10 }}>
      {shown.head.map((block, index) => render(block, `h${index}`))}
      {!shown.hidden ? null : expandable && head < ceiling ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${omitted}, tap to expand`}
          onPress={() => setExtra((value) => value + limit.head)}
          style={{ alignSelf: 'flex-start', paddingVertical: 4 }}
        >
          <Text style={{ fontSize: 14, lineHeight: 20, color: colors.run }}>{`… ${omitted}, tap to expand`}</Text>
        </Pressable>
      ) : (
        <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink3 }}>
          {expandable ? `… ${omitted}, too long; view the full content on the computer` : `… ${omitted}`}
        </Text>
      )}
      {shown.tail.map((block, index) => render(block, `t${tailStart + index}`))}
    </View>
  )
}

export type BubbleLayout = { x: number; y: number; width: number; height: number }

/**
 * On native, Text selectable steals the long press (the system copy menu and this app's message menu both appear), 
 * so native selects via "Select text" in the long-press menu; on web it is directly selectable.
 */
const inlineSelectable = Platform.OS === 'web'

function Attachments({ item }: { item: ChatItem }) {
  const colors = useColors()
  const [preview, setPreview] = useState<ImagePreviewSelection | null>(null)
  if (!item.attachments?.length) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {item.attachments.map((attachment, index) => {
        const uri = attachmentImageUri(attachment)
        return uri ? (
          <Pressable
            key={index}
            accessibilityRole="button"
            accessibilityLabel={`Preview ${attachment.name || 'Image'}`}
            onPress={() => {
              Keyboard.dismiss()
              setPreview(attachmentImageSelection(item.attachments!, index))
            }}
          >
            <Image
              source={{ uri }}
              resizeMode="cover"
              style={{ width: 120, height: 120, borderRadius: 12, backgroundColor: colors.fill }}
            />
          </Pressable>
        ) : (
          <View
            key={index}
            style={{
              maxWidth: '100%',
              minHeight: 40,
              borderRadius: 12,
              backgroundColor: item.type === 'user' ? colors.card : colors.fill,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <Icon name={attachment.type === 'image' ? 'image' : 'file'} size={18} color={colors.ink2} />
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, fontWeight: '500', color: colors.ink }}>
              {attachment.name || (attachment.type === 'image' ? 'Image' : 'Attachment')}
            </Text>
          </View>
        )
      })}
      {preview ? <ImagePreview {...preview} onClose={() => setPreview(null)} /> : null}
    </View>
  )
}

/** User bubble and assistant body; on long press hand the bubble position to the message menu so it floats up in place. */
export const Message = memo(function Message({
  item,
  onLongPress,
}: {
  item: ChatItem
  onLongPress?(item: ChatItem, layout: BubbleLayout): void
}) {
  const colors = useColors()
  const bubble = useRef<ComponentRef<typeof View>>(null)
  if (item.type === 'error')
    return <Callout tone="error">{item.text}</Callout>
  if (item.type === 'system')
    return (
      <Text selectable style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>
        {item.text}
      </Text>
    )
  const text = visibleMessageText(item.text)
  const team = text !== item.text
  const longPress = () => {
    const node = bubble.current
    if (!node || !onLongPress) return
    node.measureInWindow((x, y, width, height) =>
      onLongPress(item, { x, y, width, height })
    )
  }
  if (item.type === 'user')
    return (
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <Pressable
          accessibilityHint="Your message. Long-press to copy, select text, edit and resend, or fork"
          onLongPress={longPress}
          delayLongPress={400}
          style={{ maxWidth: 300 }}
        >
          <View ref={bubble} collapsable={false}>
            <UserBubble item={item} text={text} team={team} selectable={inlineSelectable} />
          </View>
        </Pressable>
        {item.pending ? (
          <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>
            Sent, waiting for the computer to process
          </Text>
        ) : null}
        {item.delivery === 'uncertain' ? (
          <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.attn, textAlign: 'right' }}>
            Delivery not confirmed; check the session before deciding whether to resend.
          </Text>
        ) : null}
      </View>
    )
  return (
    <Pressable
      accessibilityHint="Long-press to copy, select text or fork from here"
      onLongPress={longPress}
      delayLongPress={400}
    >
      <View ref={bubble} collapsable={false} style={{ gap: 10 }}>
        {text ? <Markdown text={text} selectable={inlineSelectable} /> : null}
        <Attachments item={item} />
      </View>
    </Pressable>
  )
})

/** User bubble itself: shared by the message stream and the floating long-press copy. */
export function UserBubble({
  item,
  text,
  team,
  selectable = false,
}: {
  item: ChatItem
  text: string
  team: boolean
  selectable?: boolean
}) {
  const colors = useColors()
  const display = userMessageDisplay(text, team)
  return (
    <View
      style={{
        backgroundColor: colors.bubble,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderBottomRightRadius: 6,
        borderBottomLeftRadius: 20,
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 8,
      }}
    >
      {display.capabilities.length ? (
        <View
          testID="user-message-capabilities"
          style={{ alignSelf: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: 6, maxWidth: '100%' }}
        >
          {display.capabilities.map((capability) => (
            <MessageCapability key={`${capability.kind}:${capability.id}`} capability={capability} />
          ))}
        </View>
      ) : null}
      {display.text ? (
        <Text
          selectable={selectable}
          style={{ fontSize: 16, lineHeight: 23, color: colors.ink }}
        >
          {display.text}
        </Text>
      ) : null}
      <Attachments item={item} />
    </View>
  )
}

function MessageCapability({ capability }: { capability: UserMessageCapability }) {
  const colors = useColors()
  return (
    <View
      testID="user-message-capability"
      accessible
      accessibilityLabel={capability.label}
      style={{ maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: colors.runTint }}
    >
      {capability.kind === 'computer' || capability.kind === 'plugin' ? (
        <Glyph name={capability.kind === 'computer' ? 'monitor' : 'plug'} size={13} color={colors.run} />
      ) : (
        <Icon name={capability.kind === 'team' ? 'users' : capability.kind === 'command' ? 'terminal' : 'sparkle'} size={13} color={colors.run} />
      )}
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12.5, lineHeight: 17, fontWeight: '600', color: colors.run }}>
        {capability.label}
      </Text>
    </View>
  )
}
