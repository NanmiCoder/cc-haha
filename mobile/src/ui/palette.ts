/**
 * Codex Pure Neutral V6C (Light `#FFFFFF` & Dark `#181818`) 统一设计 token。
 * 与桌面端 PR #2049 保持纯中性灰阶、蓝色交互强调与语义状态色完全一致。
 * 颜色只表达状态：橙棕/暖橙=等你、蓝=运行/强调、绿=完成、红=出错；
 * 主按钮在浅色用深炭、深色用纯白，确保无暖黄偏移且满足 WCAG 2.1 AA 对比度。
 */
export const light = {
  bg: '#FFFFFF',
  card: '#FAFAFA',
  cardRaised: '#FFFFFF',
  fill: '#EFEFEF',
  bubble: '#F4F4F4',
  sheet: '#F6F6F6',
  code: '#F3F3F3',
  ink: '#1A1C1F',
  ink2: '#4E4E4E',
  ink3: '#666666',
  faint: '#9A9A9A',
  chevron: '#B0B0B0',
  hair: '#E8E8E8',
  borderStrong: '#D4D4D4',
  attn: '#B8470B',
  attnDot: '#B8470B',
  attnSoft: '#FDF2EB',
  attnInk: '#923B0F',
  run: '#0169CC',
  runSoft: '#D9ECFF',
  runTint: '#EBF5FF',
  sel: '#EBF5FF',
  ok: '#008A36',
  okSoft: '#EBF7F0',
  okInk: '#00692A',
  err: '#BA2623',
  errSoft: '#FDF0F0',
  errInk: '#911E1B',
  /** 红底上的文字：浅色用白字，深色的红更亮，换成深色字才够对比度。 */
  onErr: '#FFFFFF',
  add: '#008A36',
  del: '#BA2623',
  addBg: '#ECF8F0',
  delBg: '#FDF0F0',
  addGutter: '#DDF3E4',
  delGutter: '#FADEDE',
  addInk: '#00692A',
  delInk: '#911E1B',
  hunk: '#F3F3F3',
  btn: '#1A1C1F',
  btnInk: '#FFFFFF',
  bar: 'rgba(255,255,255,0.96)',
  scrim: 'rgba(13,13,13,0.42)',
  glass: 'rgba(255,255,255,0.98)',
  glassBorder: 'rgba(0,0,0,0.08)',
  ringRunning: 'rgba(1,105,204,0.34)',
  ringWaiting: 'rgba(184,71,11,0.36)',
  mark: '#FCEBC9',
  switchOff: '#D4D4D4',
  brand: '#0169CC',
  brandPressed: '#0055A6',
  brandSoft: '#EBF5FF',
  brandBorder: '#B3D7FF',
  brandInk: '#0157AD',
  onBrand: '#FFFFFF',
  kw: '#0157AD',
  str: '#00692A',
  ty: '#6819C4',
  cm: '#666666',
}
export type Palette = typeof light

export const dark: Palette = {
  bg: '#181818',
  card: '#212121',
  cardRaised: '#282828',
  fill: '#282828',
  bubble: '#242424',
  sheet: '#131313',
  code: '#222222',
  ink: '#DFDFDF',
  ink2: '#B4B4B4',
  ink3: '#969696',
  faint: '#6E6E6E',
  chevron: '#666666',
  hair: '#2B2B2B',
  borderStrong: '#3D3D3D',
  attn: '#FF8549',
  attnDot: '#FF8549',
  attnSoft: '#2E1F16',
  attnInk: '#FFA06E',
  run: '#66B5FF',
  runSoft: '#1E344D',
  runTint: '#16273A',
  sel: '#16273A',
  ok: '#40C977',
  okSoft: '#16291E',
  okInk: '#5DD68D',
  err: '#FA423E',
  errSoft: '#2F1919',
  errInk: '#FF807D',
  onErr: '#141414',
  add: '#40C977',
  del: '#FA423E',
  addBg: '#16281D',
  delBg: '#2E1717',
  addGutter: '#1C3424',
  delGutter: '#3D1F1F',
  addInk: '#85DF7B',
  delInk: '#FF8A8B',
  hunk: '#222222',
  btn: '#FFFFFF',
  btnInk: '#141414',
  bar: 'rgba(24,24,24,0.96)',
  scrim: 'rgba(0,0,0,0.56)',
  glass: 'rgba(33,33,33,0.98)',
  glassBorder: 'rgba(255,255,255,0.09)',
  ringRunning: 'rgba(102,181,255,0.36)',
  ringWaiting: 'rgba(255,133,73,0.38)',
  mark: '#4A3A12',
  switchOff: '#3D3D3D',
  brand: '#339CFF',
  brandPressed: '#66B5FF',
  brandSoft: '#16273A',
  brandBorder: '#2B4E73',
  brandInk: '#83C3FF',
  onBrand: '#141414',
  kw: '#66B5FF',
  str: '#5DD68D',
  ty: '#C18CFF',
  cm: '#969696',
}

/** 正文用系统字体（SF Pro / PingFang / Roboto）；等宽只用于命令、路径、计时。 */
export const monoFont = 'GeistMono'

export const type = {
  largeTitle: { fontSize: 30, lineHeight: 36, fontWeight: '600', letterSpacing: -0.3 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  nav: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  headline: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 23 },
  reading: { fontSize: 16, lineHeight: 25 },
  callout: { fontSize: 15, lineHeight: 22 },
  sub: { fontSize: 14, lineHeight: 20 },
  meta: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  section: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
} as const

export const radius = {
  xs: 4,
  sm: 6,
  md: 8,
  control: 10,
  key: 11,
  inner: 12,
  button: 12,
  card: 14,
  group: 14,
  composer: 18,
  sheet: 20,
  full: 9999,
} as const

export type ShadowSet = {
  card: string
  floating: string
  composer: string
  menu: string
  popover: string
  segment: string
  sheetUp: string
  toast: string
  thumb: string
  capsule: string
  capsuleWaiting: string
}

export const lightShadows: ShadowSet = {
  card: '0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.06)',
  floating: '0 1px 2px rgba(0,0,0,0.06), 0 4px 14px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.07)',
  composer: '0 2px 10px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.07)',
  menu: '0 10px 30px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.05), 0 0 0 1px rgba(0,0,0,0.07)',
  popover: '0 8px 24px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.05), 0 0 0 1px rgba(0,0,0,0.07)',
  segment: '0 1px 2px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.06)',
  sheetUp: '0 -4px 20px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.07)',
  toast: '0 6px 20px rgba(0,0,0,0.14), 0 0 0 0.5px rgba(0,0,0,0.08)',
  thumb: '0 1px 3px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.06)',
  capsule: '0 2px 8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.07)',
  capsuleWaiting: '0 2px 10px rgba(184,71,11,0.18), 0 0 0 1px rgba(184,71,11,0.36)',
}

export const darkShadows: ShadowSet = {
  card: '0 1px 2px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(255,255,255,0.06)',
  floating: '0 2px 6px rgba(0,0,0,0.36), 0 6px 18px rgba(0,0,0,0.40), 0 0 0 0.5px rgba(255,255,255,0.08)',
  composer: '0 4px 16px rgba(0,0,0,0.36), 0 0 0 0.5px rgba(255,255,255,0.08)',
  menu: '0 12px 34px rgba(0,0,0,0.52), 0 2px 8px rgba(0,0,0,0.32), 0 0 0 0.5px rgba(255,255,255,0.09)',
  popover: '0 10px 28px rgba(0,0,0,0.48), 0 2px 6px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(255,255,255,0.09)',
  segment: '0 1px 3px rgba(0,0,0,0.34), 0 0 0 0.5px rgba(255,255,255,0.08)',
  sheetUp: '0 -6px 24px rgba(0,0,0,0.46), 0 0 0 0.5px rgba(255,255,255,0.08)',
  toast: '0 8px 24px rgba(0,0,0,0.50), 0 0 0 0.5px rgba(255,255,255,0.10)',
  thumb: '0 1px 4px rgba(0,0,0,0.44), 0 0 0 0.5px rgba(255,255,255,0.08)',
  capsule: '0 2px 10px rgba(0,0,0,0.40), 0 0 0 0.5px rgba(255,255,255,0.09)',
  capsuleWaiting: '0 2px 12px rgba(255,133,73,0.22), 0 0 0 0.5px rgba(255,133,73,0.38)',
}

export function shadowsFor(scheme: 'light' | 'dark'): ShadowSet {
  return scheme === 'dark' ? darkShadows : lightShadows
}
