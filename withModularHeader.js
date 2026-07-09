const { withDangerousMod, withPlugins } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// iOS 빌드 직전 Podfile의 맨 상단에 use_modular_headers! 코드를 강제 삽입하는 플러그인
const withCustomPodfile = (config) => {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.projectRoot, 'ios', 'Podfile');
      if (fs.existsSync(podfilePath)) {
        let podfileContent = fs.readFileSync(podfilePath, 'utf-8');
        
        // 이미 주입되어 있지 않다면 맨 위에 코드를 강제 삽입합니다.
        if (!podfileContent.includes('use_modular_headers!')) {
          podfileContent = `use_modular_headers!\n\n` + podfileContent;
          fs.writeFileSync(podfilePath, podfileContent, 'utf-8');
          console.log('✅ [Success] Podfile에 use_modular_headers! 강제 주입 완료');
        }
      }
      return config;
    },
  ]);
};

module.exports = (config) => withPlugins(config, [withCustomPodfile]);
