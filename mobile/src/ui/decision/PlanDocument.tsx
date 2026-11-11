import { View } from 'react-native'
import { CodeBlock, Mono, useColors } from '../kit'
import { monoFont } from '../palette'
import { Text } from '../Text'
import { planBlocks, planSpans, type PlanItem } from './planText'

function Spans({ text, size }: { text: string; size: number }) {
  const colors = useColors()
  return (
    <>
      {planSpans(text).map((span, index) =>
        span.code ? (
          <Text
            key={index}
            style={{
              fontFamily: monoFont,
              fontSize: Math.round(size * 0.86 * 2) / 2,
              backgroundColor: colors.fill,
              borderRadius: 5,
            }}
          >
            {`\u2009${span.text}\u2009`}
          </Text>
        ) : (
          <Text key={index} style={span.bold ? { fontWeight: '600', color: colors.ink } : undefined}>
            {span.text}
          </Text>
        )
      )}
    </>
  )
}

function Items({ items, ordered }: { items: PlanItem[]; ordered: boolean }) {
  const colors = useColors()
  const width = ordered ? Math.max(14, String(items.length).length * 9 + 5) : 14
  return (
    <View style={{ gap: 9 }}>
      {items.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', gap: 12 }}>
          <Mono style={{ width, fontSize: 16, lineHeight: 23, color: colors.ink3 }}>
            {item.marker}
          </Mono>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            {item.lines.map((line, lineIndex) => (
              <Text
                key={lineIndex}
                selectable
                style={{
                  fontSize: lineIndex ? 14 : 16,
                  lineHeight: lineIndex ? 21 : 23,
                  color: lineIndex ? colors.ink2 : colors.ink,
                }}
              >
                <Spans text={line} size={lineIndex ? 14 : 16} />
              </Text>
            ))}
          </View>
        </View>
      ))}
    </View>
  )
}

/** 计划正文：标题 23/30，段落 16/25 ink2，步骤编号等宽 ink3，路径等宽。 */
export function PlanDocument({ text }: { text: string }) {
  const colors = useColors()
  return (
    <>
      {planBlocks(text).map((block, index) => {
        switch (block.type) {
          case 'title':
            return (
              <Text
                key={index}
                accessibilityRole="header"
                selectable
                style={{ fontSize: 23, lineHeight: 30, fontWeight: '600', letterSpacing: -0.23, color: colors.ink }}
              >
                {block.text}
              </Text>
            )
          case 'heading':
            return (
              <Text
                key={index}
                accessibilityRole="header"
                style={{ fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.ink3, paddingTop: 4 }}
              >
                {block.text}
              </Text>
            )
          case 'paragraph':
            return (
              <Text key={index} selectable style={{ fontSize: 16, lineHeight: 25, color: colors.ink2 }}>
                <Spans text={block.text} size={16} />
              </Text>
            )
          case 'ordered':
          case 'bullets':
            return <Items key={index} items={block.items} ordered={block.type === 'ordered'} />
          case 'code':
            return <CodeBlock key={index}>{block.text}</CodeBlock>
        }
      })}
    </>
  )
}
