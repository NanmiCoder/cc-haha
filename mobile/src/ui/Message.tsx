import { parseUserMessageSegments } from '../../../src/shared/userMessageCapabilities'
import { memo, useMemo, useRef, useState, type ComponentRef } from 'react'
import { Image, Platform, Pressable, ScrollView, View, type TextStyle } from 'react-native'
import { Text } from './Text'
import type { ChatItem } from '../core/types'
import { visibleMessageText } from '../core/chatComposer'
import { Callout, CodeBlock, Icon, InlineCode, useColors } from './kit'
import { fitColumnWidths, naturalColumnWidths, parseInline, parseMarkdown } from './chat/markdown'

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
 * 表格：按容器的可用宽度分配列宽，整张表铺满一屏；列太多、压到可读下限还放不下时，
 * 才退回横向滑动。之前列宽只按内容估算，窄屏上表头底色和最后一列会在右侧留一截空白，
 * 看起来像被截断。
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
  // ScrollView 的 1px 边框算在布局宽度里，内容只分到去掉边框后的宽度。
  const measured = available > 2
  const fitted = measured ? fitColumnWidths(natural, available - 2) : null
  const widths = fitted ?? natural
  // 宽度还没量到（0）时先按自然列宽渲染；量到 1–2px 这种退化宽度时仍允许横滑，
  // 否则内容会超宽又动不了。
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

/** 助手正文与计划内容共用的 Markdown 渲染（16/25，代码块用 CodeBlock）。 */
export function Markdown({
  text,
  selectable = true,
}: {
  text: string
  selectable?: boolean
}) {
  const colors = useColors()
  const body: TextStyle = { fontSize: 16, lineHeight: 25, color: colors.ink }
  return (
    <View style={{ gap: 10 }}>
      {parseMarkdown(text).map((block, index) => {
        switch (block.type) {
          case 'code':
            return <CodeBlock key={index}>{block.text || ' '}</CodeBlock>
          case 'heading':
            return (
              <Inline
                key={index}
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
              <View key={index} style={{ gap: 4, paddingLeft: 4 }}>
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
                key={index}
                style={{ borderLeftWidth: 3, borderLeftColor: colors.hair, paddingLeft: 12 }}
              >
                <Inline text={block.text} selectable={selectable} style={{ ...body, color: colors.ink2 }} />
              </View>
            )
          case 'table':
            return <MarkdownTable key={index} header={block.header} rows={block.rows} selectable={selectable} />
          case 'rule':
            return <View key={index} style={{ height: 1, backgroundColor: colors.hair }} />
          default:
            return <Inline key={index} text={block.text} selectable={selectable} style={body} />
        }
      })}
    </View>
  )
}

export type BubbleLayout = { x: number; y: number; width: number; height: number }

/**
 * 原生端 Text 的 selectable 会抢走长按（系统复制菜单和本应用的消息菜单同时出现），
 * 所以原生端靠长按菜单里的“选择文字”选取；web 端直接可选中。
 */
const inlineSelectable = Platform.OS === 'web'

function Attachments({ item }: { item: ChatItem }) {
  const colors = useColors()
  if (!item.attachments?.length) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {item.attachments.map((attachment, index) =>
        attachment.type === 'image' && attachment.data ? (
          <Image
            key={index}
            accessibilityLabel={attachment.name || '图片'}
            source={{
              uri: `data:${attachment.mimeType ?? 'image/jpeg'};base64,${attachment.data.replace(/^data:[^,]*,/, '')}`,
            }}
            resizeMode="cover"
            style={{ width: 120, height: 120, borderRadius: 12, backgroundColor: colors.fill }}
          />
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
              {attachment.name || (attachment.type === 'image' ? '图片' : '附件')}
            </Text>
          </View>
        )
      )}
    </View>
  )
}

/** 用户气泡与助手正文；长按时把气泡位置交给消息菜单，让它在原处浮起。 */
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
  const team = item.text.includes('<agent-team-request>')
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
          accessibilityHint="你的消息。长按可复制、选择文字、编辑后重新发送或分叉"
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
            已发出，等待电脑处理
          </Text>
        ) : null}
        {item.delivery === 'uncertain' ? (
          <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.attn, textAlign: 'right' }}>
            未确认送达，请核对会话后再决定是否重发。
          </Text>
        ) : null}
      </View>
    )
  return (
    <Pressable
      accessibilityHint="长按可复制、选择文字或从这里分叉"
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

/** 用户气泡本体：消息流和长按浮起的副本共用。 */
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
      {text ? (
        <Text
          selectable={selectable}
          style={{ fontSize: 16, lineHeight: 23, color: colors.ink }}
        >
          {parseUserMessageSegments(text).map((segment, index) => segment.type === 'text' ? segment.text : (
            <Text key={index} style={{ fontWeight: '600', backgroundColor: colors.fill, color: colors.ink2 }}>
              {segment.type === 'command' ? segment.name : `@${segment.label}`}
            </Text>
          ))}
        </Text>
      ) : null}
      <Attachments item={item} />
      {team ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="users" size={13} color={colors.run} strokeWidth={2} />
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: colors.run }}>Agent 团队</Text>
        </View>
      ) : null}
    </View>
  )
}
