import { useState } from 'react'
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from 'react-native'
import { Text } from '../ui/Text'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useApp, useConnection } from '../state/AppContext'
import { useDashboard } from '../state/DashboardContext'
import {
  elapsedLabel,
  groupDashboard,
  relativeLabel,
  type DashboardRow,
} from '../core/dashboard'
import { Porthole } from '../ui/Porthole'
import {
  BottomBar,
  CircleButton,
  Divider,
  Empty,
  Icon,
  Inset,
  Loading,
  Notice,
  PrimaryButton,
  Raised,
  mono,
  useTheme,
} from '../ui/theme'

export default function Home() {
  const { colors: c, styles: s, dark } = useTheme()
  const { ready, error: storageError } = useApp()
  const { host, error: connectionError } = useConnection()
  const { snapshot, loading, fresh, error, refresh } = useDashboard()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState(false)
  const data = groupDashboard(
    (snapshot?.sessions ?? []).filter((session) =>
      `${session.title} ${session.workDir ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase())
    ),
    snapshot?.activity ?? []
  )
  const open = (row: DashboardRow) =>
    host &&
    router.push({
      pathname: '/chat/[id]',
      params: { id: row.session.id, host: host.id },
    })
  const dot = (color: string, size = 7) => (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  )
  return (
    <SafeAreaView
      style={[s.page, Platform.OS === 'web' && { paddingTop: 47 }]}
      edges={['top', 'left', 'right']}
    >
      <ScrollView
        contentContainerStyle={{ paddingTop: 7, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={refresh}
            tintColor={c.accent}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        <View style={[s.between, { paddingHorizontal: 20 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="搜索会话"
            onPress={() => setSearch(!search)}
            style={[s.row, { gap: 9, minHeight: 40 }]}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                borderWidth: 4,
                borderColor: c.accent,
                boxShadow: `inset 0 0 0 1.5px ${c.line}`,
              }}
            />
            <Text
              style={{
                fontFamily: 'Geist',
                fontSize: 15,
                fontWeight: '600',
                color: c.ink,
                letterSpacing: -0.15,
              }}
            >
              cc-haha
            </Text>
          </Pressable>
          <CircleButton
            name="sliders"
            label="设置"
            onPress={() => router.push('/settings')}
          />
        </View>
        {search && (
          <View style={{ paddingHorizontal: 20, paddingTop: 14 }}>
            <TextInput
              autoFocus
              accessibilityLabel="搜索会话标题"
              value={query}
              onChangeText={setQuery}
              placeholder="搜索标题或项目"
              placeholderTextColor={c.muted}
              style={s.input}
            />
          </View>
        )}
        <View
          accessibilityLabel="电脑状态"
          style={[s.row, { paddingHorizontal: 20, marginTop: 22, gap: 22 }]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`切换电脑，当前${host?.name ?? '未连接'}`}
            onPress={() => router.push('/hosts')}
          >
            <Porthole size={176} variant="home" online={fresh}>
              <View
                style={{
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    fontFamily: 'Geist',
                    fontWeight: '600',
                    fontSize: 14,
                    color: '#EDEAE4',
                    maxWidth: 108,
                  }}
                >
                  {host?.name ?? '你的电脑'}
                </Text>
                <Text
                  style={{ fontFamily: mono, fontSize: 11, color: '#A9C27A' }}
                >
                  {host
                    ? `${fresh ? '已连接' : error ? '已断开' : '连接中'} · ${host.auth === 'lan' ? '局域网' : '公网'}`
                    : '等待连接'}
                </Text>
              </View>
            </Porthole>
          </Pressable>
          <View style={{ flex: 1 }}>
            {[
              { label: '等你处理', count: data.waiting.length, color: c.amber },
              { label: '运行中', count: data.running.length, color: c.green },
              { label: '今天完成', count: data.completedToday, color: c.muted },
            ].map((item, index) => (
              <View key={item.label}>
                {index > 0 && <Divider inset={0} />}
                <View style={[s.row, { gap: 8, paddingVertical: 10 }]}>
                  {dot(item.color, 8)}
                  <Text style={{ flex: 1, color: c.secondary, fontSize: 13 }}>
                    {item.label}
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono,
                      fontSize: 22,
                      fontWeight: '500',
                      letterSpacing: -0.44,
                      color: index === 2 ? c.muted : c.ink,
                    }}
                  >
                    {fresh ? String(item.count).padStart(2, '0') : '—'}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        <View style={{ paddingHorizontal: 16, paddingTop: 24, gap: 10 }}>
          <Notice text={storageError || connectionError || error} error />
          {!ready ? (
            <Loading />
          ) : !host ? (
            <Raised style={{ padding: 18 }}>
              <Empty
                title="连接你的电脑"
                detail="扫码回到你的工作现场，随时处理审批、派任务和查看结果。"
              />
              <PrimaryButton
                title="扫码连接"
                icon="maximize"
                onPress={() => router.push('/connect')}
              />
            </Raised>
          ) : (
            <>
              {data.waiting.map((row) => (
                <Pressable
                  key={row.session.id}
                  accessibilityRole="button"
                  onPress={() => open(row)}
                >
                  <Raised
                    style={{
                      paddingTop: 14,
                      paddingBottom: 14,
                      paddingLeft: 16,
                      paddingRight: 14,
                      gap: 7,
                    }}
                  >
                    <View style={[s.row, { gap: 8 }]}>
                      {dot(c.amber)}
                      <Text
                        numberOfLines={1}
                        style={{
                          flex: 1,
                          fontSize: 15,
                          fontWeight: '600',
                          color: c.ink,
                        }}
                      >
                        {row.session.title || '未命名任务'}
                      </Text>
                    </View>
                    <View style={[s.row, { gap: 8 }]}>
                      {row.activity?.toolName === 'Bash' ? (
                        <View
                          style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <Text style={{ fontSize: 12, color: c.muted }}>
                            想运行
                          </Text>
                          <Text
                            numberOfLines={1}
                            style={{
                              flexShrink: 1,
                              fontFamily: mono,
                              fontSize: 12,
                              color: c.ink,
                              backgroundColor: c.inset,
                              paddingVertical: 3,
                              paddingHorizontal: 8,
                              borderRadius: 7,
                              boxShadow: 'inset 0 1px 2px rgba(40,30,20,.16)',
                            }}
                          >
                            {row.activity.preview ?? 'Bash'}
                          </Text>
                        </View>
                      ) : (
                        <Text
                          numberOfLines={1}
                          style={{ flex: 1, fontSize: 12, color: c.secondary }}
                        >
                          {row.activity?.toolName === 'AskUserQuestion'
                            ? '在问你：'
                            : ''}
                          {row.activity?.preview ?? '需要你做决定'}
                        </Text>
                      )}
                      <Text
                        style={{
                          fontFamily: mono,
                          fontSize: 11,
                          color: c.muted,
                        }}
                      >
                        {relativeLabel(row.session.modifiedAt)}
                      </Text>
                    </View>
                  </Raised>
                </Pressable>
              ))}
              {data.running.length > 0 && (
                <Inset style={{ marginTop: 8 }}>
                  {data.running.map((row, index) => (
                    <View key={row.session.id}>
                      {index > 0 && <Divider />}
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => open(row)}
                        style={[
                          s.row,
                          { paddingVertical: 13, paddingHorizontal: 16 },
                        ]}
                      >
                        {dot(c.green)}
                        <View style={{ flex: 1, gap: 3 }}>
                          <Text
                            numberOfLines={1}
                            style={{
                              fontSize: 14,
                              fontWeight: '500',
                              color: c.ink,
                            }}
                          >
                            {row.session.title || '未命名任务'}
                          </Text>
                          <Text
                            numberOfLines={1}
                            style={{
                              fontFamily: mono,
                              fontSize: 11,
                              color: c.secondary,
                            }}
                          >
                            {row.activity?.preview ||
                              row.session.workDir
                                ?.split(/[\\/]/)
                                .filter(Boolean)
                                .pop() ||
                              '正在处理'}
                          </Text>
                        </View>
                        <Text
                          style={{
                            fontFamily: mono,
                            fontSize: 12,
                            color: c.screenText,
                            backgroundColor: c.well,
                            paddingVertical: 4,
                            paddingHorizontal: 7,
                            borderRadius: 6,
                          }}
                        >
                          {row.activity?.startedAt
                            ? elapsedLabel(row.activity.startedAt)
                            : '运行中'}
                        </Text>
                      </Pressable>
                    </View>
                  ))}
                </Inset>
              )}
              <View style={{ marginTop: 8 }}>
                {data.settled.map((row) => (
                  <Pressable
                    key={row.session.id}
                    accessibilityRole="button"
                    onPress={() => open(row)}
                    style={[
                      s.row,
                      { paddingVertical: 11, paddingHorizontal: 16 },
                    ]}
                  >
                    {dot(
                      row.activity?.activityState === 'failed'
                        ? c.red
                        : dark ? '#4A4743' : '#C9C6BF'
                    )}
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, fontSize: 14, color: c.secondary }}
                    >
                      {row.session.title || '未命名任务'}
                    </Text>
                    {row.activity?.activityState === 'failed' && (
                      <Icon name="alert-circle" size={13} color={c.red} />
                    )}
                    <Text
                      style={{ fontFamily: mono, fontSize: 11, color: c.muted }}
                    >
                      {relativeLabel(row.session.modifiedAt)}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {!loading && !snapshot?.sessions.length && (
                <Empty
                  title="还没有任务"
                  detail="把下一件事交给电脑，在这里看它的进展。"
                />
              )}
              {query &&
                !data.waiting.length &&
                !data.running.length &&
                !data.settled.length && (
                  <Empty
                    title="没有找到会话"
                    detail="换个标题或项目名称试试。"
                  />
                )}
            </>
          )}
        </View>
      </ScrollView>
      <BottomBar>
        <PrimaryButton
          title="新任务"
          icon="plus"
          disabled={!host || !fresh}
          onPress={() =>
            host && router.push({ pathname: '/new', params: { host: host.id } })
          }
        />
      </BottomBar>
    </SafeAreaView>
  )
}
