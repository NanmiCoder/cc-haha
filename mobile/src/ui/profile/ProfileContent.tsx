import { useMemo, useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import type { ProfileOverview, ProfileStats } from '../../core/profile'
import { Button, EmptyState, InlineError, useColors } from '../kit'
import { Text } from '../Text'
import { ProfileAvatar } from './ProfileAvatar'
import { profileModel, subtitleLink, tokenAmount, tokenParts } from './profileModel'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
          <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 18, lineHeight: 25, fontWeight: '600' }}>{profile?.displayName || 'Profile not synced'}</Text>
          {profile?.subtitle ? (
            href ? (
              <Pressable accessibilityRole="link" accessibilityLabel={profile.subtitle} hitSlop={10} onPress={() => {
                setLinkError('')
                void Linking.openURL(href).catch(() => setLinkError('Cannot open the link right now; please retry later.'))
              }} style={({ pressed }) => ({ paddingVertical: 4, opacity: pressed ? 0.6 : 1 })}>
                <Text style={{ fontSize: 11, lineHeight: 17, color: colors.ink3 }}>{profile.subtitle}</Text>
              </Pressable>
            ) : <Text style={{ fontSize: 12, lineHeight: 18, color: colors.ink3 }}>{profile.subtitle}</Text>
          ) : !profile ? <Text style={{ fontSize: 12, lineHeight: 18, color: colors.ink3 }}>Avatar and nickname come from your computer</Text> : null}
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
      {onRetry ? <Button title="Resync" variant="plain" onPress={onRetry} style={{ alignSelf: 'flex-start', height: 36, paddingHorizontal: 0 }} /> : null}
    </View>
  )
}

function UsageOverview({ stats }: { stats: ProfileStats }) {
  const colors = useColors()
  const model = useMemo(() => profileModel(stats), [stats])
  const total = tokenParts(model.total)
  const hasUsage = model.total > 0 || stats.totalSessions > 0
  const metrics = [
    ['Longest task', model.longestTask],
    ['Cache hit rate', model.cacheRate],
    ['Current streak', `${stats.streaks.currentStreak} days`],
    ['Longest streak', `${stats.streaks.longestStreak} days`],
  ]
  return (
    <>
      <View style={{ paddingTop: 12, paddingBottom: 26 }}>
        <Text style={{ color: colors.ink3, fontSize: 12, lineHeight: 18 }}>Total Token</Text>
        <Text selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.55} accessibilityLabel={`${model.total.toLocaleString('en-US')} tokens total`} style={{ color: colors.ink, fontSize: 68, lineHeight: 80, fontWeight: '600', letterSpacing: -3, fontVariant: ['tabular-nums'], paddingTop: 2 }}>
          {total.amount}<Text style={{ fontSize: 30, fontWeight: '500', letterSpacing: 0, color: colors.brand }}> {total.unit}</Text>
        </Text>
        <Text style={{ color: colors.ink3, fontSize: 12, lineHeight: 18, marginTop: 4 }}>{stats.activeDays} active days<Text style={{ color: colors.chevron }}>  /  </Text>{stats.totalSessions} sessions</Text>
      </View>
      {!hasUsage ? <EmptyState icon="activity" title="No usage records yet" detail="After you start a task on the computer, your usage and activity records show here." /> : (
        <>
          <View style={{ gap: 12, paddingBottom: 24 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13, fontWeight: '500' }}>Last 30 days</Text>
              <Text style={{ color: colors.ink3, fontSize: 11 }}>{tokenAmount(model.recentTotal)} Token</Text>
            </View>
            <View accessible accessibilityRole="image" accessibilityLabel={`Token trend for the last 30 days. ${model.recent.map((day) => `${day.date}: ${tokenAmount(day.tokens)}`).join('; ')}`} style={{ height: 112, justifyContent: 'flex-end' }}>
              {[0, 0.5, 1].map((fraction) => <View key={fraction} style={{ position: 'absolute', left: 0, right: 0, bottom: fraction * 108, height: 1, backgroundColor: colors.hair }} />)}
              <View style={{ height: 108, flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
                {model.recent.map((day) => (
                  <View key={day.date} style={{ flex: 1, height: day.tokens ? Math.max(2, day.tokens / Math.max(model.peak, 1) * 108) : 1, backgroundColor: day.tokens ? colors.brand : colors.fill, opacity: day.tokens === model.peak ? 1 : 0.65, borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
                ))}
              </View>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 10, color: colors.ink3 }}>{model.recent[0].date.slice(5).replace('-', '/')}</Text>
              <Text style={{ fontSize: 10, color: colors.ink3 }}>Daily peak {tokenAmount(model.peak)}</Text>
              <Text style={{ fontSize: 10, color: colors.ink3 }}>Today</Text>
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
            <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13, fontWeight: '500', marginBottom: 10 }}>Model usage</Text>
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
            )) : <Text style={{ color: colors.ink3, fontSize: 12 }}>No model usage records yet.</Text>}
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
        <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: 13, fontWeight: '500' }}>Token Activity</Text>
        <Text style={{ color: colors.ink3, fontSize: 11 }}>Last 6 months</Text>
      </View>
      <View accessible accessibilityRole="image" accessibilityLabel={`Tokens were used on ${days.filter(day => !day.future && day.tokens > 0).length} days in the last 26 weeks; darker means more usage.`} style={{ flexDirection: 'row', gap: 3, paddingTop: 17 }}>
        {weeks.map((week, index) => (
          <View key={week[0].date} style={{ flex: 1, maxWidth: 12, gap: 3 }}>
            {(index === 0 || week[0].date.slice(5, 7) !== weeks[index - 1][0].date.slice(5, 7)) && index < 24 ? <Text style={{ position: 'absolute', top: -18, left: 0, width: 32, fontSize: 9, color: colors.ink3 }}>{MONTHS[Number(week[0].date.slice(5, 7)) - 1]}</Text> : null}
            {week.map(day => (
              <View key={day.date} style={{ aspectRatio: 1, borderRadius: 2, backgroundColor: day.tokens ? colors.brand : colors.fill, opacity: day.future ? 0 : day.tokens ? 0.2 + 0.8 * Math.sqrt(day.tokens / peak) : 1 }} />
            ))}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
        <Text style={{ color: colors.ink3, fontSize: 9, marginRight: 2 }}>Less</Text>
        {[0, 0.25, 0.5, 0.75, 1].map(level => <View key={level} style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: level ? colors.brand : colors.fill, opacity: level || 1 }} />)}
        <Text style={{ color: colors.ink3, fontSize: 9, marginLeft: 2 }}>More</Text>
      </View>
    </View>
  )
}

export function ProfileSkeleton() {
  const colors = useColors()
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Syncing profile and usage" style={{ gap: 28, paddingVertical: 8 }}>
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
