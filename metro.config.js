const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// 🌟 Metro 번들러가 .wasm 파일을 자산(Asset) 또는 소스 확장자로 인식하도록 추가
config.resolver.sourceExts.push('wasm'); 

module.exports = config;