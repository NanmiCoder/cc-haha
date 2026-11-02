import { useMemo, useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import type { ProfileOverview, ProfileStats } from '../../core/profile'
import { Button, EmptyState, InlineError, useColors } from '../kit'
import { Text } from '../Text'
import { ProfileAvatar } from './ProfileAvatar'
import { profileModel, subtitleLink, tokenAmount, tokenParts } from './profileModel'

export function ProfileContent({ overview, onRetry }: { overview: ProfileOverview; onRetry?(): void }) {
  const colors = useColors()
  const { profile, stats } = overview
  const [linkError, setLinkError] = useState('')
  const href = profile ? subtitleLink(profile.subtitle) : null
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 8, paddingBottom: 22 }}>
        <ProfileAvatar profile={profile} />
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 18, lineHeight: 25, fontWeight: '600' }}>{profile?.displayName || '资料未同步'}</Text>
          {profile?.subtitle ? (
            href ? (
              <Pressable accessibilityRole="link" accessibilityLabel={profile.subtitle} hitSlop={10} onPress={() => {
                setLinkError('')
                void Linking.openURL(href).catch(() => setLinkError('暂时无法打开链接，请稍后重试。'))
              }} style={({ pressed }) => ({ paddingVertical: 4, opacity: pressed ? 0.6 : 1 })}>
                <Text style={{ fontSize: 11, lineHeight: 17, color: colors.ink3 }}>{profile.subtitle}</Text>
              </Pressable>
            ) : <Text style={{ fontSize: 12, lineHeight: 18, color: colors.ink3 }}>{profile.subtitle}</Text>
          ) : !profile ? <Text style={{ fontSize: 12, lineHeight: 18, color: colors.ink3 }}>头像和昵称来自你的电脑</Text> : null}
        </View>
      </View>
      {overview.profileError ? <SyncNotice text={overview.profileError} onRetry={onRetry} /> : null}
      <InlineError text={linkError} />
      {stats ? <UsageOverview stats={stats} /> : null}
      {overview.statsError ? <SyncNotice text={overview.statsError} onRetry={onRetry} /> : null}
    </>
  )
}

function SyncNotice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const colors = useColors()
  return (
    <View style={{ padding: 12, gap: 6, borderRadius: 10, backgroundColor: colors.fill, marginBottom: 18 }}>
      <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, lineHeight: 18, color: colors.ink2 }}>{text}</Text>
      {onRetry ? <Button title="重新同步" variant="plain" onPress={onRetry} style={{ alignSelf: 'flex-start', height: 36, paddingHorizontal: 0 }} /> : null}
    </View>
  )
}

function UsageOverview({ stats }: { stats: ProfileStats }) {
  const colors = useColors()
  const model = useMemo(() => profileModel(stats), [stats])
  const total = tokenParts(model.total)
  const hasUsage = model.total > 0 || stats.totalSessions > 0
  const metrics = [
    ['最长任务', model.longestTask],
    ['缓存命中率', model.cacheRate],
    ['当前连续', `${stats.streaks.currentStreak} 天`],
    ['最长连续', `${stats.streaks.longestStreak} 天`],
  ]
  return (
    <>
      <View style={{ paddingTop: 12, paddingBottom: 26 }}>
        <Text style={{ color: colors.ink3, fontSize: 12, lineHeight: 18 }}>累计 Token</Text>
        <Text selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.55} accessibilityLabel={`累计 ${model.total.toLocaleString('zh-CN')} Token`} style={{ color: colors.ink, fontSize: 68, lineHeight: 80, fontWeight: '600', letterSpacing: -3, fontVariant: ['tabular-nums'], paddingTop: 2 }}>
          {total.amount}<Text style={{ fontSize: 30, fontWeight: '500', letterSpacing: 0, color: colors.brand }}> {total.unit}</Text>
        </Text>
        <Text style={{ color: colors.ink3, fontSize: 12, lineHeight: 18, marginTop: 4 }}>{stats.activeDays} 个活跃日<Text style={{ color: colors.chevron }}>  /  </Text>{stats.totalSessions} 次会话</Text>
      </View>
      {!hasUsage ? <EmptyState icon="activity" title="还没有使用记录" detail="在电脑上开始一个任务后，这里会展示你的用量和活跃记录。" /> : (
        <>
          <View style={{ gap: 12, paddingBottom: 24 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13, fontWeight: '500' }}>近 30 天</Text>
              <Text style={{ color: colors.ink3, fontSize: 11 }}>{tokenAmount(model.recentTotal)} Token</Text>
            </View>
            <View accessible accessibilityRole="image" accessibilityLabel={`近30天 Token 趋势。${model.recent.map((day) => `${day.date}：${tokenAmount(day.tokens)}`).join('；')}`} style={{ height: 112, justifyContent: 'flex-end' }}>
              {[0, 0.5, 1].map((fraction) => <View key={fraction} style={{ position: 'absolute', left: 0, right: 0, bottom: fraction * 108, height: 1, backgroundColor: colors.hair }} />)}
              <View style={{ height: 108, flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
                {model.recent.map((day) => (
                  <View key={day.date} style={{ flex: 1, height: day.tokens ? Math.max(2, day.tokens / Math.max(model.peak, 1) * 108) : 1, backgroundColor: day.tokens ? colors.brand : colors.fill, opacity: day.tokens === model.peak ? 1 : 0.65, borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
                ))}
              </View>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 10, color: colors.ink3 }}>{model.recent[0].date.slice(5).replace('-', '/')}</Text>
              <Text style={{ fontSize: 10, color: colors.ink3 }}>单日最高 {tokenAmount(model.peak)}</Text>
              <Text style={{ fontSize: 10, color: colors.ink3 }}>今天</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.hair, paddingVertical: 6 }}>
            {metrics.map(([label, value]) => (
              <View key={label} style={{ width: '50%', paddingVertical: 12, paddingRight: 10, gap: 6 }}>
                <Text style={{ color: colors.ink3, fontSize: 11, lineHeight: 16 }}>{label}</Text>
                <Text style={{ color: colors.ink, fontSize: 17, lineHeight: 24, fontWeight: '500', fontVariant: ['tabular-nums'] }}>{value}</Text>
              </View>
            ))}
          </View>
          <ActivityCalendar days={model.days} />
          <View style={{ paddingTop: 26 }}>
            <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13, fontWeight: '500', marginBottom: 10 }}>模型用量</Text>
            {model.models.length ? model.models.map((item) => (
              <View key={item.id} style={{ paddingVertical: 10, gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'baseline' }}>
                  <Text style={{ flex: 1, minWidth: 0, color: colors.ink2, fontSize: 12, lineHeight: 18 }}>{item.id}</Text>
                  <Text style={{ color: colors.ink3, fontSize: 12, fontVariant: ['tabular-nums'] }}>{tokenAmount(item.total)}</Text>
                </View>
                <View style={{ height: 3, backgroundColor: colors.fill, borderRadius: 2, overflow: 'hidden' }}>
                  <View style={{ height: 3, width: `${item.total / Math.max(model.modelTotal, 1) * 100}%`, backgroundColor: colors.brand, opacity: 0.7, borderRadius: 2 }} />
                </View>
              </View>
            )) : <Text style={{ color: colors.ink3, fontSize: 12 }}>暂无模型用量记录。</Text>}
          </View>
        </>
      )}
    </>
  )
}

function ActivityCalendar({ days }: { days: ReturnType<typeof profileModel>['days'] }) {
  const colors = useColors()
  const peak = Math.max(...days.filter(day => !day.future).map(day => day.tokens), 1)
  const weeks = Array.from({ length: 26 }, (_, index) => days.slice(index * 7, index * 7 + 7))
  return (
    <View style={{ paddingTop: 24, gap: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13, fontWeight: '500' }}>Token 活动</Text>
        <Text style={{ color: colors.ink3, fontSize: 11 }}>近半年</Text>
      </View>
      <View accessible accessibilityRole="image" accessibilityLabel={`近26周有 ${days.filter(day => !day.future && day.tokens > 0).length} 天使用了 Token，颜色越深表示用量越多。`} style={{ flexDirection: 'row', gap: 3, paddingTop: 17 }}>
        {weeks.map((week, index) => (
          <View key={week[0].date} style={{ flex: 1, maxWidth: 12, gap: 3 }}>
            {(index === 0 || week[0].date.slice(5, 7) !== weeks[index - 1][0].date.slice(5, 7)) && index < 24 ? <Text style={{ position: 'absolute', top: -18, left: 0, width: 32, fontSize: 9, color: colors.ink3 }}>{Number(week[0].date.slice(5, 7))}月</Text> : null}
            {week.map(day => (
              <View key={day.date} style={{ aspectRatio: 1, borderRadius: 2, backgroundColor: day.tokens ? colors.brand : colors.fill, opacity: day.future ? 0 : day.tokens ? 0.2 + 0.8 * Math.sqrt(day.tokens / peak) : 1 }} />
            ))}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
        <Text style={{ color: colors.ink3, fontSize: 9, marginRight: 2 }}>少</Text>
        {[0, 0.25, 0.5, 0.75, 1].map(level => <View key={level} style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: level ? colors.brand : colors.fill, opacity: level || 1 }} />)}
        <Text style={{ color: colors.ink3, fontSize: 9, marginLeft: 2 }}>多</Text>
      </View>
    </View>
  )
}

export function ProfileSkeleton() {
  const colors = useColors()
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="正在同步个人资料和用量" style={{ gap: 28, paddingVertical: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.fill }} />
        <View style={{ flex: 1, gap: 12 }}>
          <View style={{ width: '75%', height: 18, borderRadius: 4, backgroundColor: colors.fill }} />
          <View style={{ width: '90%', height: 10, borderRadius: 4, backgroundColor: colors.fill }} />
        </View>
      </View>
      <View style={{ width: '60%', height: 78, borderRadius: 6, backgroundColor: colors.fill }} />
      <View style={{ height: 120, borderRadius: 6, backgroundColor: colors.fill }} />
    </View>
  )
}
