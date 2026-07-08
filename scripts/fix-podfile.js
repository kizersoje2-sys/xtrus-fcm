// scripts/fix-podfile.js
const fs = require('fs');
const podfilePath = 'ios/Podfile';

if (fs.existsSync(podfilePath)) {
  let content = fs.readFileSync(podfilePath, 'utf8');
  const patch = `
  installer.pods_project.targets.each do |target|
    if ['RNFBApp', 'RNFBCore'].include?(target.name)
      target.build_configurations.each do |config|
        config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
      end
    end
  end
`;
  if (!content.includes('CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES')) {
    content = content.replace('post_install do |installer|', 'post_install do |installer|' + patch);
    fs.writeFileSync(podfilePath, content);
    console.log('Podfile patched successfully');
  }
}