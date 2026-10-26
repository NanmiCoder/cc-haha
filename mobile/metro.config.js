const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
// This repository keeps separate installs rather than declaring package-manager
// workspaces, so Expo cannot discover the shared, platform-neutral source folder.
// Keep mobile's default dependency resolution; do not pull in desktop React.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../src/shared')]

module.exports = config
