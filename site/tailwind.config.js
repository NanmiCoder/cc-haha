export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'Inter', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        display: ['Special Elite', 'Georgia', 'serif']
      },
      colors: { wandor: { dark: '#0a0a0a', text: '#1a1a1a', muted: '#767676', prompt: '#905831' } }
    }
  }
}
