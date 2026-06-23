const { getDefaultConfig } = require('expo/config-metro');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// 💡 1. 자산(Asset) 확장자에 wasm 추가
config.resolver.assetExts.push('wasm');

// 💡 2. 소스(Source) 확장자에 wasm 추가 (중복 방지 처리)
if (!config.resolver.sourceExts.includes('wasm')) {
  config.resolver.sourceExts.push('wasm');
}

module.exports = config;