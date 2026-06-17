import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMessaging, getToken, onTokenRefresh } from '@react-native-firebase/messaging';
import CryptoJS from 'crypto-js';
import * as Clipboard from 'expo-clipboard';
import * as MailComposer from 'expo-mail-composer';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  DeviceEventEmitter,
  FlatList,
  Image,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import * as DeviceInfo from 'react-native-device-info';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getOrGenerateDeviceId } from '../../util/deviceId';

// 알림 핸들러 설정
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let inDb: any = null;
const SECRET_KEY = CryptoJS.enc.Utf8.parse('12345678901234567890123456789012'); // 32바이트 (AES-256)
const SHARE_IV = CryptoJS.enc.Utf8.parse('1234567890123456'); // 16바이트
const FCM_REGISTERED_KEY = 'XTRUS_FCM_REGISTERED_STATUS';
const LAST_CLEAN_DATE_KEY = 'LAST_DATABASE_CLEAN_DATE';

// 로그 시간 포맷터 함수
const formatLogTime = (timeStr: string | undefined | null): string => {
  if (!timeStr) return '날짜 정보 없음';
  if (/^\d{17}$/.test(timeStr)) {
    return timeStr.replace(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/,
      '$1-$2-$3 $4:$5:$6:$7'
    );
  }
  return timeStr;
};

export default function HomeScreen() {
  // 1. 공통 및 인증 관련 상태
  const [fcmToken, setFcmToken] = useState<string>('');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [ADMIN_EMAIL, setAdEmail] = useState('');
  const [isPageLoading, setIsPageLoading] = useState<boolean>(true); // 앱 최초 구동 로딩

  // 2. 화면 전환 플래그
  const [isRegistered, setIsRegistered] = useState<boolean>(false);  // FCM 인증 완료 여부 (최종 리스트 화면)
  const [isWaitingAuth, setIsWaitingAuth] = useState<boolean>(false); // 메일 발송 후 푸시 대기 상태 여부

  // 3. 리스트 및 모달 관련 상태
  const [pushList, setPushList] = useState<any[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [isModalVisible, setIsModalVisible] = useState<boolean>(false);

  // 4. 기기 등록 리소스 등록
  const adEmailInputRef = useRef<TextInput>(null);
  const userIdInputRef = useRef<TextInput>(null);

  // 5. 기기 인증 정보(기기정보 상태값)
  const [accessIp, setAccessIp] = useState<string>('');
  const [countryCode, setCountryCode] = useState<string>('');

  // 최초 앱 초기화 및 DB 연결
  useEffect(() => {
    let isMounted = true; // 메모리 누수 방지 플래그

    const initializeApp = async () => {
      try {
        inDb = SQLite.openDatabaseSync('fcm_history.db');
        await initDB();
        await registerForPushNotificationsAsync();

        const id = await getOrGenerateDeviceId();
        if (isMounted) setDeviceId(id);

        // 영구 저장소에서 등록 상태 확인
        const registeredStatus = await SecureStore.getItemAsync(FCM_REGISTERED_KEY);
        if (registeredStatus === 'true') {
          if (isMounted) setIsRegistered(true);
          // 이미 인증된 기기라면 로그 목록 로드
          loadNotificationLogs();
        }
      } catch (error) {
        console.error('초기화 에러:', error);
      } finally {
        if (isMounted) setIsPageLoading(false);
      }
    };
    initializeApp();

    // 푸시 알림 수신 동적 리스너
    const onPushReceived = async (title: string, body: string, data: any) => {
      await handlerIncomingPush(title, body, data);

      // 푸시를 받으면 대기 상태 해제, 등록 완료 처리 후 리스트 갱신
      const registeredStatus = await SecureStore.getItemAsync(FCM_REGISTERED_KEY);
      if (registeredStatus !== 'true') {
        await SecureStore.setItemAsync(FCM_REGISTERED_KEY, 'true');
        if (isMounted) {
          setIsRegistered(true);
          setIsWaitingAuth(false); // 대기 화면 종료
        }
        Alert.alert("인증 완료", "최초 FCM 알림 수신이 확인되어 기기 등록이 완료되었습니다!");
      }
      loadNotificationLogs();
    };

    const foregroundListener = Notifications.addNotificationReceivedListener(notification => {
      const body = notification.request.content.body || "내용 없는 알림";
      const title = notification.request.content.title || "알림";
      const data = notification.request.content.data || {};
      onPushReceived(title, body, data);
    });

    const responseListener = Notifications.addNotificationResponseReceivedListener(response => {
      const body = response.notification.request.content.body || "내용 없는 알림";
      const title = response.notification.request.content.title || "알림";
      const data = response.notification.request.content.data || {};
      onPushReceived(title, body, data);
    });

    // 내부 수신 이벤트 리스너
    const subscription = DeviceEventEmitter.addListener('NewPushDataArrived', () => {
      loadNotificationLogs();
    });

    const checkTokenOnStart = async () => {
      const messagingInstance = getMessaging();
      const currentToken = await getToken(messagingInstance);
      const savedToken = await SecureStore.getItemAsync('SAVED_FCM_TOKEN');

      if (savedToken && currentToken !== savedToken) {
        await SecureStore.deleteItemAsync(FCM_REGISTERED_KEY);
        if (isMounted) {
          setIsRegistered(false);
          setIsWaitingAuth(true);
        }
        Alert.alert("인증 만료", "푸시 토큰이 변경되어 재인증이 필요합니다.");
      }

      await SecureStore.setItemAsync('SAVED_FCM_TOKEN', currentToken);
      if (isMounted) setFcmToken(currentToken);
    };

    // ⭐ 구형 경고 수정을 위해 onTokenRefresh 뒤에 괄호() 명시적 추가 및 함수형 변경
    const unsubscribe = onTokenRefresh(getMessaging(), async (newToken) => {
      console.log("fcm 토큰이 새롭게 갱신되었습니다.", newToken);
      try {
        if (isMounted) setFcmToken(newToken);
        await SecureStore.deleteItemAsync(FCM_REGISTERED_KEY);
        if (isMounted) {
          setIsRegistered(false);
          setIsWaitingAuth(false);
        }
        Alert.alert(
          "인증 갱신",
          "푸시 토큰이 변경되어 재인증이 필요합니다.\n발송된 메일을 확인하여 다시 인증을 완료해 주세요.",
          [{ text: "확인" }]
        );
      } catch (error) {
        console.error(error);
      }
    });
    checkTokenOnStart();

    // IP 및 국가 판별
    const checkLocationByIp = async () => {
      try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        const currentPublicIp = ipData.ip;

        if (isMounted) {
          setAccessIp(currentPublicIp);
          console.log("현재 아이피 :: ", currentPublicIp);
        }

        const geoResponse = await fetch(`http://ip-api.com/json/${currentPublicIp}`);
        const geoData = await geoResponse.json();

        if (isMounted) {
          if (geoData && geoData.countryCode === 'KR') {
            setCountryCode('KR');
          } else {
            setCountryCode('OTHER');
          }
        }
      } catch (err) {
        console.error("IP 로드 실패:", err);
      }
    };
    checkLocationByIp();

    return () => {
      isMounted = false; // 컴포넌트 해제 시 플래그 off
      foregroundListener.remove();
      responseListener.remove();
      subscription.remove();
      unsubscribe();
    };
  }, []);


  // DB 테이블 생성
  const initDB = async () => {
    try {
      if (!inDb) {
        inDb = SQLite.openDatabaseSync('fcm_history.db');
      }
      await inDb.execAsync(`
        CREATE TABLE IF NOT EXISTS notification_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT,
          body TEXT,
          logTime TEXT,
          messageName TEXT,
          messageCtrlId TEXT,
          senderTpId TEXT,
          senderSvcId TEXT,
          recverTpId TEXT,
          recverSvcId TEXT,
          errorPattern TEXT,
          errorType TEXT,
          errorCode TEXT,
          errorContents TEXT,
          errorLocation TEXT,
          errorModuleID TEXT,
          useDuplicationCheck TEXT,
          templateID TEXT,
          nodeId TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } catch (error) {
      console.error('init db fail', error);
    }
  };

  // 로그 데이터 가져오기 및 주간 청소
  const loadNotificationLogs = async () => {
    if (!inDb) return;
    const todayStr = new Date().toISOString().split('T')[0];
    const lastCleanDate = await AsyncStorage.getItem(LAST_CLEAN_DATE_KEY);

    try {
      setListLoading(true);
      if (lastCleanDate !== todayStr) {
        await inDb.runAsync(`
          DELETE FROM notification_logs 
          WHERE logTime < strftime('%Y%m%d%H%M%S', 'now', '-7 days', 'localtime') || '999'
        `);
        console.log("1주일 지난 오래된 로그 청소 완료");
        await AsyncStorage.setItem(LAST_CLEAN_DATE_KEY, todayStr);
      }
      console.log('데이터 로드!!');
      const rows: any[] = await inDb.getAllAsync('SELECT * FROM notification_logs ORDER BY id DESC');
      setPushList(rows);
    } catch (error) {
      console.error("보관함 로드 에러:", error);
    } finally {
      setListLoading(false);
    }
  };

  // 수신된 푸시 DB 인서트
  const handlerIncomingPush = async (title: string, body: string, data: any) => {
    try {
      const query = `
        INSERT INTO notification_logs (
          title, body, logTime, messageName, messageCtrlId,
          senderTpId, senderSvcId, recverTpId, recverSvcId,
          errorPattern, errorType, errorCode, errorContents, errorLocation,
          errorModuleID, useDuplicationCheck, templateID, nodeId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `;

      const params = [
        title,
        body,
        data.logTime || "",
        data.messageName || "",
        data.messageCtrlId || "",
        data.senderTpId || "",
        data.senderSvcId || "",
        data.recverTpId || "",
        data.recverSvcId || "",
        data.errorPattern || "",
        data.errorType || "",
        data.errorCode || "",
        data.errorContents || "",
        data.errorLocation || "",
        data.errorModuleID || "",
        data.useDuplicationCheck || "",
        data.templateID || "",
        data.nodeId || ""
      ];

      await inDb.runAsync(query, params);
      DeviceEventEmitter.emit('NewPushDataArrived');
    } catch (error) {
      console.error("DB 저장 중 에러 발생:", error);
    }
  };

  // 푸시 토큰 발급 및 권한 요청
  async function registerForPushNotificationsAsync() {
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: true, allowSound: true }
        });
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        Alert.alert('알림 권한', '푸시 알림 권한이 거부되었습니다.');
        return;
      }

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('xtrus-fcm', {
          name: '알림',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250]
        });
      }

      const tokenData = await Notifications.getDevicePushTokenAsync();
      if (tokenData && tokenData.data) {
        setFcmToken(tokenData.data);
        await SecureStore.setItemAsync('SAVED_FCM_TOKEN', tokenData.data);
      }
    } catch (error) {
      console.error('토큰 생성 중 오류 발생', error);
    }
  }

  // 암호화 인증 메일 전송
  async function sendEmailWithToken() {
    const isAvailable = await MailComposer.isAvailableAsync();
    const platformStr = Platform.OS === 'android' ? 'AOS_APP' : 'IOS_APP';

    if (!isAvailable) {
      Alert.alert('오류', '이메일을 보낼 수 있는 메일 앱이 설정되어 있지 않습니다.');
      return;
    }
    if (!ADMIN_EMAIL.trim()) {
      Alert.alert("알림", "관리자 이메일 주소를 입력해 주세요.", [
        { text: "확인", onPress: () => setTimeout(() => adEmailInputRef.current?.focus(), 100) }
      ]);
      return;
    }
    if (!userId.trim()) {
      Alert.alert("알림", "아이디를 입력해 주세요.", [
        { text: "확인", onPress: () => setTimeout(() => userIdInputRef.current?.focus(), 100) }
      ]);
      return;
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(ADMIN_EMAIL)) {
      Alert.alert("입력 오류", "이메일 주소 형식이 올바르지 않습니다.");
      return;
    }
    if (!deviceId || !fcmToken) {
      Alert.alert("알림", "기기 정보나 FCM 토큰을 불러오는 중입니다.");
      return;
    }

    try {
      // 💡 [버그 방어]: 메일 발송 직전, 무조건 최신의 공인 IP와 기기 스펙을 동기식으로 한 번 더 즉시 채집합니다.
      const ipResponse = await fetch('https://api.ipify.org?format=json');
      const ipData = await ipResponse.json();
      const directIp = ipData.ip;

      const geoResponse = await fetch(`http://ip-api.com/json/${directIp}`);
      const geoData = await geoResponse.json();
      const directCountry = (geoData && geoData.countryCode === 'KR') ? 'KR' : 'OTHER';

      const directModel = DeviceInfo.getModel();
      const directOS = DeviceInfo.getSystemVersion();
      const directAppVer = DeviceInfo.getVersion();

      // 파이프(|) 구분자로 로우 데이터 매핑하여 유실 방지
      const rawData = `${userId}|${deviceId}|${fcmToken}|${platformStr}|${directIp}|${directCountry}|${directAppVer}|${directOS}|${directModel}`;
      
      const encrypted = CryptoJS.AES.encrypt(rawData, SECRET_KEY, {
        iv: SHARE_IV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }).toString();

      const result = await MailComposer.composeAsync({
        recipients: [ADMIN_EMAIL],
        subject: 'xTrus 장애통보 기기등록 요청',
        body: `안녕하세요, 관리자님.\n아래 암호화된 텍스트를 복사하여 등록해 주세요.\n\n[ENCRYPTED_DATA]\n${encrypted}\n\n감사합니다.`
      });

      if (result.status === MailComposer.MailComposerStatus.SENT) {
        setIsWaitingAuth(true);
      }
    } catch (error) {
      Alert.alert("오류", "암호화 및 메일 전송 중 에러가 발생했습니다.");
    }
  }

  // 클립보드 복사 함수
  async function copyEncryptedTokenToClipboard() {
    const platformStr = Platform.OS === 'android' ? 'AOS_APP' : 'IOS_APP';

    if (!ADMIN_EMAIL.trim()) {
      Alert.alert("알림", "관리자 이메일 주소를 입력해 주세요.", [
        { text: "확인", onPress: () => setTimeout(() => adEmailInputRef.current?.focus(), 100) }
      ]);
      return;
    }
    if (!userId.trim()) {
      Alert.alert("알림", "아이디를 입력해 주세요.", [
        { text: "확인", onPress: () => setTimeout(() => userIdInputRef.current?.focus(), 100) }
      ]);
      return;
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(ADMIN_EMAIL)) {
      Alert.alert("입력 오류", "이메일 주소 형식이 올바르지 않습니다.", [
        { text: "확인", onPress: () => setTimeout(() => adEmailInputRef.current?.focus(), 100) }
      ]);
      return;
    }
    if (!deviceId || !fcmToken) {
      Alert.alert("알림", "기기 정보나 FCM 토큰을 불러오는 중입니다.");
      return;
    }
    try {
      // 💡 복사하기 기능도 마찬가지로 누수 방지용 실시간 데이터 갱신 결합
      const directModel = DeviceInfo.getModel();
      const directOS = DeviceInfo.getSystemVersion();
      const directAppVer = DeviceInfo.getVersion();

      const rawData = `${userId}|${deviceId}|${fcmToken}|${platformStr}|${accessIp || '127.0.0.1'}|${countryCode || 'KR'}|${directAppVer}|${directOS}|${directModel}`;
      console.log(rawData);
      const encrypted = CryptoJS.AES.encrypt(rawData, SECRET_KEY, {
        iv: SHARE_IV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }).toString();
      console.log(encrypted);
      console.log(encrypted.length);
      await Clipboard.setStringAsync(encrypted);
      Alert.alert("복사 완료", "암호화된 정보가 클립보드에 복사되었습니다.");
    } catch (error) {
      console.error(error);
      Alert.alert("오류", "복사 중 알 수 없는 오류 발생");
    }
  }

  // 헤더 버튼 전용: 다시 1번 인증 등록 폼 화면으로 돌아가는 함수
  const resetToAuthForm = async () => {
    Keyboard.dismiss();

    setTimeout(() => {
      Alert.alert(
        "인증 초기화",
        "초기화 시 다시 인증 메일을 발송해야 합니다. 진행하시겠습니까?",
        [
          { text: "취소", style: "cancel", onPress: () => { Keyboard.dismiss() } },
          {
            text: "확인",
            onPress: async () => {
              await SecureStore.deleteItemAsync(FCM_REGISTERED_KEY);
              setIsRegistered(false);
              setIsWaitingAuth(false);
            }
          }
        ],
        { cancelable: true }
      );
    }, 100);
  };

  // --- 렌더링 영역 분기 ---

  // A. 앱 실행 초기 풀 스크린 로딩
  if (isPageLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#0056b3" />
      </View>
    );
  }

  // B. [3단계] FCM 인증이 완료되어 활성화된 최종 장애통보 리스트 화면
  if (isRegistered) {
    return (
      <SafeAreaView style={styles.listContainer}>
        <View style={styles.headerFull}>
          <Image
            source={require('../../assets/images/top_left.jpg')}
            style={styles.headerLogoFull}
            resizeMode="cover"
          />
          <TouchableOpacity
            activeOpacity={0.8}
            style={styles.resetButtonAbsolute}
            onPress={resetToAuthForm}
          >
            <Text style={styles.resetButtonText}>인증 초기화</Text>
          </TouchableOpacity>
        </View>

        {listLoading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#0284c7" />
          </View>
        ) : pushList.length === 0 ? (
          <View style={styles.centerContainer}>
            <Text style={styles.emptyText}>수신된 시스템 알림 및 에러 로그가 없습니다.</Text>
          </View>
        ) : (
          <FlatList
            data={pushList}
            keyExtractor={(item) => item.id.toString()}
            contentContainerStyle={{ padding: 16 }}
            renderItem={({ item }) => {
              let cardStyle: any[] = [styles.card];
              if (item.errorType === 'E') cardStyle.push(styles.errorCard);
              else if (item.errorType === 'W') cardStyle.push(styles.warningCard);

              return (
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={cardStyle}
                  onPress={() => { setSelectedItem(item); setIsModalVisible(true); }}
                >
                  <View style={styles.cardHeader}>
                    <Text style={styles.msgName}>메세지명: {item.messageName || "UNKNOWN_MSG"}</Text>
                    {item.errorType === 'E' ? (
                      <Text style={styles.errBadge}>에러: {item.errorCode || 'E'}</Text>
                    ) : item.errorType === 'W' ? (
                      <Text style={styles.warningBadge}>경고: {item.errorCode || 'W'}</Text>
                    ) : (
                      <Text style={styles.normalBadge}>INFO: {item.errorCode || 'I'}</Text>
                    )}
                  </View>

                  <Text style={styles.cardBody}>{item.body || item.errorContents}</Text>

                  <View style={styles.metaContainer}>
                    <Text style={styles.metaText}>• MessageCtrlId : {item.messageCtrlId || '-'}</Text>
                    <Text style={styles.metaText}>• 송신: {item.senderTpId || 'ANY'}  ➔  수신: {item.recverTpId || 'ANY'}</Text>
                    {item.errorLocation ? <Text style={styles.metaText}>• 위치 : {item.errorLocation}</Text> : null}
                    {item.errorContents ? <Text style={styles.metaText}>• 내용 : {item.errorContents}</Text> : null}
                  </View>

                  <Text style={styles.cardTime}>
                    로그시간: {formatLogTime(item.logTime || item.created_at)}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
        )}

        {/* 상세 모달 팝업 */}
        <Modal
          animationType='fade'
          transparent={true}
          visible={isModalVisible}
          onRequestClose={() => setIsModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalHeader}>장애통보 상세 보기</Text>
              <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={true}>
                {selectedItem && (
                  <View style={styles.modalDetailContainer}>
                    <Text style={styles.modalLabel}>Message Name</Text>
                    <Text style={styles.modalValueText}>{selectedItem.messageName || "UNKNOWN_MSG"}</Text>

                    <Text style={styles.modalLabel}>에러 코드 (Error Code)</Text>
                    <Text style={[
                      styles.modalValueText,
                      selectedItem.errorType === 'E' ? { color: '#dc3545' } : selectedItem.errorType === 'W' ? { color: '#f0753b' } : { color: '#198754' }
                    ]}>
                      {selectedItem.errorType === 'E' ? `에러: ${selectedItem.errorCode || 'E'}` : selectedItem.errorType === 'W' ? `경고: ${selectedItem.errorCode || 'W'}` : 'INFO (정상)'}
                    </Text>

                    <Text style={styles.modalLabel}>에러 내용 (Contents)</Text>
                    <Text style={styles.modalLargeBodyBox}>{selectedItem.errorContents || '내용 없음'}</Text>

                    <Text style={styles.modalLabel}>Message Control ID</Text>
                    <Text style={styles.modalInfoText}>{selectedItem.messageCtrlId || '-'}</Text>

                    <Text style={styles.modalLabel}>송신 ➔ 수신</Text>
                    <Text style={styles.modalInfoText}>{selectedItem.senderTpId || 'ANY'} ➔ {selectedItem.recverTpId || 'ANY'}</Text>

                    {selectedItem.errorLocation && (
                      <>
                        <Text style={styles.modalLabel}>장애 발생 위치 (Location)</Text>
                        <Text style={styles.modalInfoText}>{selectedItem.errorLocation}</Text>
                      </>
                    )}

                    <Text style={styles.modalLabel}>로그 기록 시간</Text>
                    <Text style={styles.modalInfoText}>{formatLogTime(selectedItem.logTime || selectedItem.created_at)}</Text>
                  </View>
                )}
              </ScrollView>
              <View style={styles.modalButtonContainer}>
                <Button title="닫기" color="#0056b3" onPress={() => setIsModalVisible(false)} />
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // C. [2단계] 메일 발송 완료 후 테스트 푸시 무한 대기 상태 화면
  if (isWaitingAuth) {
    return (
      <SafeAreaView style={styles.listContainer}>
        <View style={styles.headerFull}>
          <Image
            source={require('../../assets/images/top_left.jpg')}
            style={styles.headerLogoFull}
            resizeMode="cover"
          />
        </View>
        <View style={styles.waitingContent}>
          <View style={styles.waitingBox}>
            <ActivityIndicator size="large" color="#f0753b" style={{ marginBottom: 20 }} />
            <Text style={styles.waitingTitle}>기기 정보 등록 대기 중...</Text>
            <Text style={styles.waitingDescription}>
              관리자에게 기기 등록 요청 메일이 전송되었습니다.{"\n"}
              최초 푸시 알림이 본 단말기에 도달하면{"\n"}
              장애통보 리스트로 전환됩니다.
            </Text>
            <View style={{ marginTop: 30, width: '100%', gap: 10 }}>
              <Button title="이전 단계로 돌아가기" color="#6c757d" onPress={() => setIsWaitingAuth(false)} />
              <Button
                title="[개발용] 푸시 강제 완료 (다음단계)"
                color="#eb5151"
                onPress={async () => {
                  await SecureStore.setItemAsync(FCM_REGISTERED_KEY, 'true');
                  setIsRegistered(true);
                  setIsWaitingAuth(false);
                  loadNotificationLogs();
                }}
              />
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // D. [1단계] 최초 기기 등록 및 이메일 전송 입력 폼 화면
  return (
    <SafeAreaView style={styles.listContainer}>
      <View style={styles.headerFull}>
        <Image
          source={require('../../assets/images/top_left.jpg')}
          style={styles.headerLogoFull}
          resizeMode="cover"
        />
      </View>
      <ScrollView
        contentContainerStyle={styles.formContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>xTrus 장애통보 기기 등록</Text>
        <Text style={styles.description}>
          최초 1회 관리자에게 이메일을 전송하여 기기를 등록해야 합니다.{"\n"}
          등록 후 테스트 푸시를 받으면 이 화면은 자동으로 전환됩니다.
        </Text>
        <Text style={styles.descriptionPoint}>
          (※알림 : 푸시 토큰은 언제든 초기화 될 수 있습니다. 초기화 시 해당 재 인증 과정 필수.)
        </Text>

        <TextInput
          ref={adEmailInputRef}
          style={styles.input}
          value={ADMIN_EMAIL}
          onChangeText={setAdEmail}
          placeholder="관리자 이메일 주소 입력"
          keyboardType='email-address'
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="emailAddress"
          returnKeyType="next"
          onSubmitEditing={() => {
            if (userIdInputRef.current) {
              userIdInputRef.current.focus();
            }
          }}
        />

        <TextInput
          ref={userIdInputRef}
          style={styles.input}
          value={userId}
          onChangeText={setUserId}
          placeholder="사용자 아이디(ID) 입력"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
        />

        <View style={styles.infoBox}>
          <Text style={styles.infoText} numberOfLines={1}>
            기기 ID: {' '}
            <Text style={deviceId ? styles.textSuccess : styles.textDanger}>
              {deviceId ? '준비 완료' : '로딩 중...'}
            </Text>
          </Text>
          <Text style={styles.infoText} numberOfLines={1}>
            FCM 토큰: {' '}
            <Text style={fcmToken ? styles.textSuccess : styles.textDanger}>
              {fcmToken ? '준비 완료' : '로딩 중...'}
            </Text>
          </Text>
          <TouchableOpacity
            style={[
              styles.copyButton,
              (!fcmToken || !userId.trim()) && { backgroundColor: '#cbd5e1' }
            ]}
            onPress={copyEncryptedTokenToClipboard}
            activeOpacity={0.7}
          >
            <Text style={styles.copyButtonText}>암호화된 정보 복사하기</Text>
          </TouchableOpacity>
        </View>

        <Button title="관리자에게 인증 메일 보내기" onPress={sendEmailWithToken} color="#0056b3" />
        <View style={{ marginTop: 10, width: '100%', gap: 10 }}></View>
        <Button title="[개발용] 이메일 전송 강제 완료 (다음단계)" onPress={() => setIsWaitingAuth(true)} color="#eb5151" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#f8f9fa' },
  listContainer: { flex: 1, backgroundColor: '#f4f6f9' },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: 65,
  },
  headerLogo: { height: '100%' },
  headerFull: {
    width: '100%',
    height: 65,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    position: 'relative',
    overflow: 'hidden',
  },
  headerLogoFull: { width: '100%', height: '100%' },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#1e293b' },
  resetButtonAbsolute: {
    position: 'absolute',
    right: 16,
    top: '50%',
    marginTop: -14,
    backgroundColor: 'rgba(220, 53, 69, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    zIndex: 999,
    elevation: 5
  },
  resetButtonText: { color: '#ffffff', fontSize: 12, fontWeight: 'bold' },
  emptyText: { color: '#64748b', fontSize: 14 },
  formContent: { padding: 24, justifyContent: 'center' },
  waitingBox: { alignItems: 'center', padding: 20, backgroundColor: '#ffffff', borderRadius: 16, elevation: 3, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 },
  waitingTitle: { fontSize: 20, fontWeight: 'bold', color: '#f0753b', marginBottom: 12 },
  waitingDescription: { fontSize: 14, color: '#495057', textAlign: 'center', lineHeight: 22 },
  waitingContent: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 25, fontWeight: 'bold', color: '#212529', marginBottom: 8 },
  description: { fontSize: 15, color: '#6c757d', lineHeight: 20 },
  descriptionPoint: { fontSize: 14, color: '#e01653', marginBottom: 24, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: '#ced4da', backgroundColor: '#fff', padding: 12, borderRadius: 8, fontSize: 16, marginBottom: 16 },
  infoBox: { padding: 16, backgroundColor: '#e9ecef', borderRadius: 8, marginBottom: 24 },
  infoText: { fontSize: 14, fontWeight: '600', color: '#495057', marginBottom: 6 },
  textSuccess: { color: '#198754', fontWeight: 'bold' },
  textDanger: { color: '#dc3545', fontWeight: 'bold' },
  copyButton: {
    backgroundColor: '#383f49',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#383f49',
  },
  copyButtonText: { color: '#ffffff', fontSize: 14, fontWeight: 'bold' },
  card: { backgroundColor: '#ffffff', padding: 14, borderRadius: 12, marginBottom: 14, borderWidth: 1, borderColor: '#e2e8f0', elevation: 1 },
  errorCard: { borderColor: '#fca5a5', backgroundColor: '#fffdfd' },
  warningCard: { borderColor: '#f0753b', backgroundColor: '#fffdfd' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  msgName: { fontSize: 13, fontWeight: 'bold', color: '#0284c7' },
  errBadge: { backgroundColor: '#ef4444', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  warningBadge: { backgroundColor: '#f0753b', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  normalBadge: { backgroundColor: '#10b981', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  cardBody: { fontSize: 14, color: '#334155', marginBottom: 10, lineHeight: 20 },
  metaContainer: { backgroundColor: '#f8fafc', padding: 10, borderRadius: 6, marginBottom: 6, borderWidth: 0.5, borderColor: '#cbd5e1' },
  metaText: { fontSize: 11, color: '#475569', fontFamily: 'monospace', marginBottom: 2 },
  cardTime: { fontSize: 11, color: '#94a3b8', textAlign: 'right', marginTop: 4 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { width: '100%', maxHeight: '80%', backgroundColor: '#fff', borderRadius: 16, padding: 20, elevation: 10 },
  modalHeader: { fontSize: 18, fontWeight: 'bold', color: '#212529', borderBottomWidth: 1, borderBottomColor: '#e9ecef', paddingBottom: 12, marginBottom: 16 },
  modalScroll: { marginBottom: 16 },
  modalDetailContainer: { gap: 14 },
  modalLabel: { fontSize: 12, fontWeight: 'bold', color: '#0056b3' },
  modalValueText: { fontSize: 18, fontWeight: 'bold', color: '#212529' },
  modalLargeBodyBox: { fontSize: 17, color: '#343a40', lineHeight: 26, backgroundColor: '#f8f9fa', padding: 14, borderRadius: 8, borderWidth: 1, borderColor: '#e9ecef' },
  modalInfoText: { fontSize: 15, color: '#495057' },
  modalButtonContainer: { borderTopWidth: 1, borderTopColor: '#e9ecef', paddingTop: 12 }
});