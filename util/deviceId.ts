import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'XTRUS_DEVICE_ID';

export const getOrGenerateDeviceId = async (): Promise<string> => {
  try {
    let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    console.log('1. SecureStore 요청 결과값:', deviceId);

    if (!deviceId) {
      console.log('2. 기존 키 없음 -> 새로운 UUID 생성 중...');
      deviceId = Crypto.randomUUID();
      await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
      console.log('3. 새로운 UUID 저장 완료:', deviceId);
    }
    return deviceId;
  } catch (error) {
    // 💥 중요: 에러가 나면 콘솔에 범인을 무조건 출력하도록 설정
    console.error('🔥 기기 고유번호 추출 실패 원인:', error);
    return "ERROR_FALLBACK_ID"; 
  }
};