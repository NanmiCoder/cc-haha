import { useMemo, useState } from 'react'
import { FlatList, ScrollView, View, useWindowDimensions } from 'react-native'
import { Mono, useColors } from '../kit'
import { highlight, type CodeLanguage, type Token, type TokenKind } from './highlight'

const LINE = 21
const FONT = 12.5
/** GeistMono 的字宽是 0.6em；中日韩等全角字符按 1em 估算。 */
const NARROW = FONT * 0.6
const WIDE = FONT
const MAX_WIDTH = 12000

function columnsWidth(tokens: Token[]) {
  let width = 0
  for (const token of tokens)
    for (let index = 0; index < token.text.length; index++)
      width += token.text.charCodeAt(index) > 0x2e7f ? WIDE : NARROW
  return width
}

/** 只读代码视图：行号 + 轻量高亮；按行虚拟化，长行整体横向滚动。 */
export function CodeView({ content, language }: { content: string; language: CodeLanguage }) {
  const colors = useColors()
  const { width: screenWidth, fontScale } = useWindowDimensions()
  const [height, setHeight] = useState(0)
  // Keep native text scaling; scale only the surrounding geometry once.
  const rowHeight = Math.ceil(LINE * fontScale)
  const lines = useMemo(() => {
    const result = highlight(content.replace(/\t/g, '    '), language)
    // 文件末尾的换行不算新的一行。
    if (result.length > 1 && !result[result.length - 1]!.length) result.pop()
    return result
  }, [content, language])
  const gutter = Math.max(34, String(lines.length).length * NARROW + 4) * fontScale + 12
  const width = useMemo(() => {
    let widest = 0
    for (const line of lines) widest = Math.max(widest, columnsWidth(line))
    return Math.min(MAX_WIDTH * fontScale, Math.max(screenWidth, Math.ceil(gutter + widest * fontScale * 1.04 + 24)))
  }, [lines, gutter, screenWidth, fontScale])
  const tone: Record<TokenKind, string> = {
    kw: colors.kw,
    str: colors.str,
    ty: colors.ty,
    cm: colors.cm,
    plain: colors.ink,
  }
  return (
    <View
      style={{ flex: 1 }}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      {height > 0 ? (
        <ScrollView horizontal bounces={false} contentContainerStyle={{ minWidth: '100%' }}>
          <FlatList
            style={{ width, height }}
            contentContainerStyle={{ paddingVertical: 10 }}
            data={lines}
            keyExtractor={(_, index) => String(index)}
            getItemLayout={(_, index) => ({ length: rowHeight, offset: 10 + rowHeight * index, index })}
            initialNumToRender={60}
            maxToRenderPerBatch={80}
            windowSize={9}
            renderItem={({ item, index }) => (
              <View style={{ height: rowHeight, flexDirection: 'row', overflow: 'hidden' }}>
                <Mono
                  style={{
                    width: gutter,
                    paddingRight: 12,
                    textAlign: 'right',
                    fontSize: FONT,
                    lineHeight: LINE,
                    color: colors.chevron,
                  }}
                >
                  {index + 1}
                </Mono>
                <Mono
                  selectable
                  style={{ flex: 1, paddingRight: 16, fontSize: FONT, lineHeight: LINE, color: colors.ink }}
                >
                  {item.map((token, position) =>
                    token.kind === 'plain' ? (
                      token.text
                    ) : (
                      <Mono key={position} style={{ fontSize: FONT, color: tone[token.kind] }}>
                        {token.text}
                      </Mono>
                    )
                  )}
                </Mono>
              </View>
            )}
          />
        </ScrollView>
      ) : null}
    </View>
  )
}
