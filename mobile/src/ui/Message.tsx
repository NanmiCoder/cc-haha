import { useState } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'
import { Text } from './Text'
import type { ChatItem } from '../core/types'
import { visibleMessageText } from '../core/chatComposer'
import { Icon, Inset, mono, useTheme } from './theme'

export function Markdown({
  text,
  selectable = true,
}: {
  text: string
  selectable?: boolean
}) {
  const { colors: c, styles: s } = useTheme()
  return (
    <View style={{ gap: 9 }}>
      {text.split(/(```[\s\S]*?```)/g).map((part, index) => {
        if (part.startsWith('```'))
          return (
            <ScrollView
              key={index}
              horizontal
              style={{
                borderRadius: 12,
                backgroundColor: c.well,
                boxShadow: 'inset 0 1px 3px #00000060',
              }}
              contentContainerStyle={{ padding: 14 }}
            >
              <Text
                selectable={selectable}
                style={{
                  color: '#D8D4CA',
                  fontFamily: mono,
                  fontSize: 12,
                  lineHeight: 20,
                }}
              >
                {part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}
              </Text>
            </ScrollView>
          )
        return part.split('\n').map((line, lineIndex) => {
          const heading = line.match(/^(#{1,4})\s+(.+)$/)
          const value = heading ? heading[2] : line.replace(/^[-*]\s+/, '• ')
          return value ? (
            <Text
              key={`${index}-${lineIndex}`}
              selectable={selectable}
              style={[
                s.text,
                { lineHeight: 24 },
                heading && {
                  fontSize: heading[1].length < 3 ? 18 : 16,
                  fontWeight: '600',
                  marginTop: 6,
                },
              ]}
            >
              {value
                .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
                .map((segment, segmentIndex) => (
                  <Text
                    key={segmentIndex}
                    style={
                      segment.startsWith('**')
                        ? { fontWeight: '600' }
                        : segment.startsWith('`')
                          ? { fontFamily: mono, fontSize: 13 }
                          : undefined
                    }
                  >
                    {segment.startsWith('**')
                      ? segment.slice(2, -2)
                      : segment.startsWith('`')
                        ? segment.slice(1, -1)
                        : segment}
                  </Text>
                ))}
            </Text>
          ) : (
            <View key={`${index}-${lineIndex}`} style={{ height: 2 }} />
          )
        })
      })}
    </View>
  )
}

export function Message({
  item,
  onLongPress,
}: {
  item: ChatItem
  onLongPress?(item: ChatItem): void
}) {
  const { colors: c, styles: s } = useTheme()
  const [expanded, setExpanded] = useState(false)
  if (item.type === 'tool' || item.type === 'thinking')
    return (
      <View
        style={{
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: c.well,
          boxShadow: 'inset 0 1px 3px #00000070',
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`展开 ${item.toolName || '思考过程'}`}
          onPress={() => setExpanded((value) => !value)}
          onLongPress={() => onLongPress?.(item)}
          style={[s.row, { padding: 13, gap: 9 }]}
        >
          <Icon
            name={
              item.type === 'thinking'
                ? 'sun'
                : item.isError
                  ? 'alert-circle'
                  : 'terminal'
            }
            size={15}
            color={item.isError ? '#EBA38D' : c.screenText}
          />
          <Text
            style={{
              flex: 1,
              color: '#D8D4CA',
              fontFamily: mono,
              fontSize: 12,
            }}
          >
            {item.toolName || '思考过程'}
            {item.pending ? ' · 进行中' : ''}
          </Text>
          <Icon
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color="#8D897F"
          />
        </Pressable>
        {expanded && (
          <View style={{ padding: 14, paddingTop: 0, gap: 10 }}>
            <Text
              selectable
              style={{
                color: '#D8D4CA',
                fontFamily: mono,
                fontSize: 12,
                lineHeight: 20,
              }}
            >
              {item.type === 'thinking'
                ? item.text
                : JSON.stringify(
                    item.input ?? item.partialInput ?? {},
                    null,
                    2
                  )}
            </Text>
            {item.result !== undefined && (
              <Text
                selectable
                style={{
                  color: '#BEB8AC',
                  fontFamily: mono,
                  fontSize: 12,
                  lineHeight: 20,
                }}
              >
                {typeof item.result === 'string'
                  ? item.result
                  : JSON.stringify(item.result, null, 2)}
              </Text>
            )}
          </View>
        )}
      </View>
    )
  if (item.type === 'system' || item.type === 'error')
    return (
      <Text
        selectable
        style={[s.small, { color: item.type === 'error' ? c.red : c.muted }]}
      >
        {item.text}
      </Text>
    )
  const body = (
    <View style={{ gap: 8 }}>
      {item.text ? (
        <Markdown text={visibleMessageText(item.text)} selectable={false} />
      ) : null}
      {item.text.includes('<agent-team-request>') && (
        <Text style={[s.small, { color: c.secondary }]}>♧ Agent 团队</Text>
      )}
      {item.attachments?.map((attachment, index) =>
        attachment.type === 'image' && attachment.data ? (
          <Image
            key={index}
            source={{
              uri: `data:${attachment.mimeType ?? 'image/jpeg'};base64,${attachment.data.replace(/^data:[^,]*,/, '')}`,
            }}
            resizeMode="contain"
            style={{ width: '100%', height: 170, borderRadius: 10 }}
          />
        ) : (
          <View key={index} style={s.row}>
            <Icon name="file-text" size={16} />
            <Text style={[s.small, { flexShrink: 1 }]} numberOfLines={1}>
              {attachment.name || '附件'}
            </Text>
          </View>
        )
      )}
      {item.type === 'user' && item.pending && (
        <Text style={s.small}>已发出，等待电脑处理</Text>
      )}
      {item.delivery === 'uncertain' && (
        <Text style={[s.small, { color: c.accent }]}>
          未确认送达，请核对会话后再决定是否重发。
        </Text>
      )}
    </View>
  )
  return (
    <Pressable
      accessibilityLabel={
        item.type === 'user' ? '你的消息，长按查看操作' : '回复，长按查看操作'
      }
      onLongPress={() => onLongPress?.(item)}
      delayLongPress={400}
      style={
        item.type === 'user'
          ? {
              alignSelf: 'flex-end',
              maxWidth: '88%',
              ...(item.attachments?.length ? { width: '88%' } : {}),
            }
          : { paddingHorizontal: 4, paddingVertical: 2 }
      }
    >
      {item.type === 'user' ? (
        <Inset
          style={{
            borderBottomRightRadius: 6,
            paddingHorizontal: 14,
            paddingVertical: 12,
          }}
        >
          {body}
        </Inset>
      ) : (
        body
      )}
    </Pressable>
  )
}
