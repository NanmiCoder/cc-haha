import { CHANNEL_IDS, LEGACY_CHANNEL_ID } from './channelIds'

/**
 * Android 渠道的创建清单。纯数据 + 注入的 API，不依赖原生模块，方便单测。
 * importance 数值与 expo-notifications 的 AndroidImportance 一致（DEFAULT=5、HIGH=6；
 * 注意 3 是 MIN、4 是 LOW，会变成无横幅的静默渠道——测试里对照了枚举定义文件）。
 * 渠道一旦创建，系统就固定了重要程度和声音，之后再调用只能改名字——所以这里的值
 * 不要随意改；要换行为只能新增渠道 id。
 */
export const IMPORTANCE_DEFAULT = 5
export const IMPORTANCE_HIGH = 6

export type ChannelSpec = {
  id: string
  name: string
  importance: number
  sound?: 'default' | null
  vibrationPattern?: number[]
}

/** 顺序固定：先三个分渠道，最后才是兼容旧版电脑的 legacy 渠道。 */
export const CHANNEL_SPECS: ChannelSpec[] = [
  {
    id: CHANNEL_IDS.decisions,
    name: '要我做决定',
    importance: IMPORTANCE_HIGH,
    vibrationPattern: [0, 250, 250, 250],
  },
  {
    id: CHANNEL_IDS.completed,
    name: '任务完成',
    importance: IMPORTANCE_DEFAULT,
  },
  {
    id: CHANNEL_IDS.errors,
    name: '出错或卡住',
    importance: IMPORTANCE_HIGH,
    vibrationPattern: [0, 250, 250, 250],
  },
  // 旧版电脑仍把推送发到这个渠道；登记时没带 channels: 'split' 就会走它。
  {
    id: LEGACY_CHANNEL_ID,
    name: '任务与审批',
    importance: IMPORTANCE_HIGH,
  },
]

export type ChannelApi = {
  setNotificationChannelAsync(
    id: string,
    config: Omit<ChannelSpec, 'id'>
  ): Promise<unknown>
}

/** 逐个创建，任何一个失败都向上抛，调用方据此决定能否声明 channels: 'split'。 */
export async function createNotificationChannels(
  platform: string,
  api: ChannelApi
) {
  if (platform !== 'android') return
  for (const { id, ...config } of CHANNEL_SPECS)
    await api.setNotificationChannelAsync(id, config)
}
