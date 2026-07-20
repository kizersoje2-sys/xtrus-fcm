import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import * as Sentry from '@sentry/react-native';
import CryptoJS from 'crypto-js';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Clipboard from 'expo-clipboard';
import * as MailComposer from 'expo-mail-composer';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  DeviceEventEmitter,
  FlatList,
  Image,
  Keyboard,
  Linking,
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

let inDb: any = null;
const SECRET_KEY = CryptoJS.enc.Utf8.parse('12345678901234567890123456789012'); // 32바이트 (AES-256)
const SHARE_IV = CryptoJS.enc.Utf8.parse('1234567890123456'); // 16바이트
const FCM_REGISTERED_KEY = 'XTRUS_FCM_REGISTERED_STATUS';
const LAST_CLEAN_DATE_KEY = 'LAST_DATABASE_CLEAN_DATE';
const TOKEN_CHECK_TASK = 'TOKEN_CHECK_TASK';

TaskManager.defineTask(TOKEN_CHECK_TASK, async () => {
  try {

    if (Platform.OS === 'ios') {
      await messaging().registerDeviceForRemoteMessages();
    }

    const currentToken = await messaging().getToken();
    const savedToken = await SecureStore.getItemAsync('SAVED_FCM_TOKEN');
    if (savedToken && currentToken !== savedToken) {
      // 토큰이 변경되었으므로 로컬 알림 발송
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "인증 만료 안내",
          body: "앱 인증 토큰이 변경되었습니다. 재인증을 위해 앱을 실행해주세요.",
        },
        trigger: null, // 즉시 발송
      });
    }
    return BackgroundFetch.BackgroundFetchResult.NewData;

  } catch (error) {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// 백그라운드 상태에 토큰 상태 체크
const registerBackgroundFetch = async () => {

  await BackgroundFetch.registerTaskAsync(TOKEN_CHECK_TASK, {
    minimumInterval: 60 * 60, // 1시간
    stopOnTerminate: false,
    startOnBoot: true,
  });
};

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


Notifications.setNotificationHandler({
  handleNotification: async () => {
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    };
  },
});

messaging().setBackgroundMessageHandler(async remoteMessage => {
  console.log('[백그라운드] FCM 수신:', JSON.stringify(remoteMessage.data));
  Sentry.captureMessage(`백그라운드 FCM 수신: ${JSON.stringify(remoteMessage.data)}`);
  if (!inDb) {
    inDb = SQLite.openDatabaseSync('fcm_history.db');
  }
  const title = String(remoteMessage.data?.title || remoteMessage.notification?.title || "알림");
  const body = String(remoteMessage.data?.body || remoteMessage.notification?.body || "내용 없는 알림");
  const data = remoteMessage.data || {};

  if (Platform.OS === 'ios') {
    try {
      await Notifications.scheduleNotificationAsync({
        content: { title, body, sound: 'default', data },
        trigger: null,
      });
    } catch (error) {
      Sentry.captureMessage(`[백그라운드] 배너 표시 실패: ${String(error)}`);
    }
  }

  try {

    const query = `
      INSERT OR IGNORE INTO notification_logs (
        logTime, messageName, messageCtrlId,
        senderTpId, senderSvcId, recverTpId, recverSvcId,
        errorPattern, errorType, errorCode, errorContents, errorLocation,
        errorModuleID, useDuplicationCheck, templateID, nodeId, docNumber
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;

    const params = [
      data.logTime || "", data.messageName || "", data.messageCtrlId || "",
      data.senderTpId || "", data.senderSvcId || "", data.recverTpId || "", data.recverSvcId || "",
      data.errorPattern || "", data.errorType || "", data.errorCode || "", data.errorContents || "", data.errorLocation || "",
      data.errorModuleID || "", data.useDuplicationCheck || "", data.templateID || "", data.nodeId || "", data.docNumber || ""
    ];

    const result = await inDb.runAsync(query, params);
    Sentry.captureMessage(`[백그라운드] INSERT 결과: changes=${result.changes}`);
    DeviceEventEmitter.emit('NewPushDataArrived');


  } catch (error) {
    console.error("백그라운드 처리 실패:", error);
    Sentry.captureMessage(`[백그라운드] DB 저장 실패: ${String(error)}`);
  }
  
  return Promise.resolve();
});

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
  const [searchText, setSearchText] = useState<string>('');
  const [searchKeyword, setSearchKeyword] = useState<string>('');
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [isListEnd, setIsListEnd] = useState(false);

  // 4. 기기 등록 리소스 등록
  const adEmailInputRef = useRef<TextInput>(null);
  const userIdInputRef = useRef<TextInput>(null);

  // 5. 기기 인증 정보(기기정보 상태값)
  const [accessIp, setAccessIp] = useState<string>('');
  const [countryCode, setCountryCode] = useState<string>('');

  //데이터 더 불러오기
  const fetchMoreData = async (isNew = false, keyword = '') => {
    if (loading || (!isNew && isListEnd)) return;

    setLoading(true);
    try {
      const nextPage = isNew ? 0 : page;
      const offset = nextPage * 10;

      let whereClause = "";
      const params: any[] = [];
      console.log(searchKeyword.trim());

      const targetKeyword = keyword || searchKeyword;

      if (targetKeyword.trim()) {
        whereClause += " WHERE messageName LIKE ? OR docNumber LIKE ? OR senderTpId LIKE ? OR recverTpId LIKE ?";
        const pattern = `%${targetKeyword}%`;
        params.push(pattern, pattern, pattern, pattern);
      }

      if (startDate || endDate) {

        if (!whereClause) whereClause = " WHERE 1=1 ";

        if (startDate) {
          whereClause += "AND SUBSTR(logTime, 1, 8) >= ? ";
          params.push(startDate);
        }

        if (endDate) {
          whereClause += "AND SUBSTR(logTime, 1, 8) <= ? ";
          params.push(endDate);
        }
      }

      const query = `SELECT * FROM notification_logs ${whereClause} ORDER BY id DESC LIMIT 10 OFFSET ${offset}`;
      console.log('데이터 쿼리 :: ', query);
      // console.log('데이터 파라메터 :: ', params);
      const newData = await inDb.getAllAsync(query, params);
      // console.log('데이터 로드!!' , newData);
      if (newData.length < 10)
        setIsListEnd(true);
      else
        setIsListEnd(false);

      setPushList(isNew ? newData : [...pushList, ...newData]);
      setPage(nextPage + 1);

    } catch (err) {
      console.error("데이터 로드 실패:", err);
    } finally {
      setLoading(false);
    }
  };


  // 최초 앱 초기화 및 DB 연결
  useEffect(() => {
    let isMounted = true; // 메모리 누수 방지 플래그

    const initializeApp = async () => {
      try {
        inDb = SQLite.openDatabaseSync('fcm_history.db');
        await initDB();
        await registerForPushNotificationsAsync();
        await registerBackgroundFetch();
        const id = await getOrGenerateDeviceId();
        if (isMounted) setDeviceId(id);

        const registeredStatus = await SecureStore.getItemAsync(FCM_REGISTERED_KEY);
        if (registeredStatus === 'true') {
          if (isMounted) setIsRegistered(true);
          // 이미 인증된 기기라면 로그 목록 로드
          fetchMoreData(true);
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

      const safeData = typeof data === 'object' && data !== null ? data : {};

      // 문자열로 안전하게 꺼내 쓰기 위해 string 타입 단언(as string) 또는 변환 처리
      await handlerIncomingPush(title, body, safeData);

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

    };

    const responseListener = Notifications.addNotificationResponseReceivedListener(response => {

      SecureStore.getItemAsync(FCM_REGISTERED_KEY).then((registeredStatus) => {
        if (registeredStatus !== 'true') {
          SecureStore.setItemAsync(FCM_REGISTERED_KEY, 'true').then(() => {
            if (isMounted) {
              setIsRegistered(true);
              setIsWaitingAuth(false);
            }
            Alert.alert("인증 완료", "최초 FCM 알림 수신이 확인되어 기기 등록이 완료되었습니다!");
          });
        } else {
          // 3. 이미 인증된 사용자라면 알림을 눌러 들어왔을 때 리스트를 최신화해 줍니다.
          if (isMounted) {
            //loadNotificationLogs();
            fetchMoreData(true);
          }
        }
      }).catch(err => console.error("클릭 리스너 처리 에러:", err));

    });

    let refreshTimeout: number | null = null;
    // 내부 수신 이벤트 리스너
    const subscription = DeviceEventEmitter.addListener('NewPushDataArrived', () => {
      // 1. 푸시가 연속으로 오면 기존에 예약되어 있던 리로드 타이머를 즉시 취소합니다.
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }

      // 2. 새로운 타이머를 세팅합니다. (마지막 푸시가 오고 800ms 동안 잠잠하면 실행)
      refreshTimeout = window.setTimeout(() => {
        if (isMounted) {
          console.log('푸시 연속 수신 종료: 리스트를 1회만 새로고침합니다.');
          //loadNotificationLogs(); //
          fetchMoreData(true);
        }
      }, 1000);
    });

    const checkTokenOnStart = async () => {

      if (Platform.OS === 'ios') {
        await messaging().registerDeviceForRemoteMessages();
      }

      const currentToken = await messaging().getToken();
      const savedToken = await SecureStore.getItemAsync('SAVED_FCM_TOKEN');

      if (savedToken && currentToken !== savedToken) {
        await SecureStore.deleteItemAsync(FCM_REGISTERED_KEY);
        if (isMounted) {
          setIsRegistered(false);
          setIsWaitingAuth(true);
        }
        Alert.alert("인증 만료", "푸시 토큰이 변경되어 재인증이 필요합니다.");

        await messaging().deleteToken();
        const freshToken = await messaging().getToken();
        await SecureStore.setItemAsync('SAVED_FCM_TOKEN', freshToken);
        if (isMounted) setFcmToken(freshToken);
        return; // 아래 중복 저장 방지
      }
      await SecureStore.setItemAsync('SAVED_FCM_TOKEN', currentToken);
      if (isMounted) setFcmToken(currentToken);
    };

    // 경고 수정을 위해 onTokenRefresh 뒤에 괄호() 명시적 추가 및 함수형 변경
    const unsubscribe = messaging().onTokenRefresh(async (newToken) => {
      console.log("fcm 토큰이 새롭게 갱신되었습니다.", newToken);
      try {
        if (isMounted) setFcmToken(newToken);
        await SecureStore.deleteItemAsync(FCM_REGISTERED_KEY);
        if (isMounted) {
          setIsRegistered(false);
          setIsWaitingAuth(false);
        }

        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'xTrus 장애통보 알림',
            body: 'FCM 보안 토큰이 변경되었습니다. 앱을 실행하여 재인증 절차를 진행해주세요.',
            data: { data: 'token_changed' },
          },
          trigger: null, // 즉시 발송
        });
        // Alert.alert(
        //   "인증 갱신",
        //   "푸시 토큰이 변경되어 재인증이 필요합니다.\n발송된 메일을 확인하여 다시 인증을 완료해 주세요.",
        //   [{ text: "확인" }]
        // );
      } catch (error) {
        console.error(error);
      }
    });
    checkTokenOnStart();

    const unsubscribeForegroundFCM = messaging().onMessage(async remoteMessage => {
      console.log(' 포그라운드 FCM 수신:', JSON.stringify(remoteMessage));
      Sentry.captureMessage(`포그라운드 FCM 수신: ${JSON.stringify(remoteMessage.data)}`);

      const title = String(remoteMessage.data?.title || remoteMessage.notification?.title || "알림");
      const body = String(remoteMessage.data?.body || remoteMessage.notification?.body || "내용 없는 알림");
      const data = remoteMessage.data || {};

      // 강제로 동적 핸들러 호출해서 DB 적재 및 리스트 갱신 실행
      await onPushReceived(title, body, data);

      await Notifications.scheduleNotificationAsync({
        content: {
          title: title,
          body: body,
          sound: 'default', // 알림음 출력
          data: data,       // 누르면 상세화면 갈 수 있도록 파라미터 매핑
        },
        trigger: null,      // 즉시 발동
      });

    });

    // IP 및 국가 판별
    const checkLocationByIp = async () => {
      try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        const currentPublicIp = ipData.ip;

        if (isMounted) {
          setAccessIp(currentPublicIp);
        }

        const geoResponse = await fetch(`https://ipwho.is/${currentPublicIp}`);
        const geoData = await geoResponse.json();

        if (isMounted) {
          if (geoData && geoData.country_code === 'KR') {
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
      responseListener.remove();
      subscription.remove();
      unsubscribe();
      unsubscribeForegroundFCM();

      if (refreshTimeout) clearTimeout(refreshTimeout);
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
          docNumber TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(messageCtrlId, logTime)
        );
      `);
    } catch (error) {
      console.error('init db fail', error);
    }
  };

  // 로그 데이터 가져오기 및 청소
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
        console.log("7일 지난 오래된 로그 청소 완료");
        await AsyncStorage.setItem(LAST_CLEAN_DATE_KEY, todayStr);
      }

      const rows: any[] = await inDb.getAllAsync('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 10 OFFSET 0');

      setPushList(rows);
      setPage(1);
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
        INSERT OR IGNORE INTO notification_logs (
          logTime, messageName, messageCtrlId,
          senderTpId, senderSvcId, recverTpId, recverSvcId,
          errorPattern, errorType, errorCode, errorContents, errorLocation,
          errorModuleID, useDuplicationCheck, templateID, nodeId, docNumber
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `;

      const params = [
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
        data.nodeId || "",
        data.docNumber || ""
      ];


      const result = await inDb.runAsync(query, params);
      const countRow: any = await inDb.getFirstAsync('SELECT COUNT(*) as cnt FROM notification_logs');
      const lastRows: any[] = await inDb.getAllAsync('SELECT id, logTime, messageCtrlId FROM notification_logs ORDER BY id DESC LIMIT 10');

      Sentry.captureMessage(
        `INSERT 결과: changes=${result.changes} / 전체row수=${countRow.cnt} / 최근10건=${JSON.stringify(lastRows)}`
      );
      // await inDb.runAsync(query, params);
      // Sentry.captureMessage(`DB 저장 성공: ${data.messageCtrlId || data.logTime}`); // ← 추가
      DeviceEventEmitter.emit('NewPushDataArrived');
    } catch (error) {
      Sentry.captureMessage(`DB 저장 실패: ${String(error)} / ctrlId=${data.messageCtrlId || data.logTime}`); // ← 추가
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
        Alert.alert(
          '알림 권한 필요',
          '푸시 알림 권한이 거부되었습니다.\n정상적인 서비스 이용을 위해 설정에서 알림 권한을 허용해 주세요.',
          [
            { text: '취소', style: 'cancel' },
            {
              text: '설정으로 이동',
              style: 'default',
              onPress: async () => {
                try {
                  if (Platform.OS === 'ios') {
                    await Linking.openURL('app-settings:');
                  } else {
                    await Linking.openSettings();
                  }
                } catch (error) {
                  Alert.alert('오류', '설정 화면을 열 수 없습니다. 수동으로 권한 설정을 변경해주세요.');
                }
              }
            }
          ]
        );
        return;
      }

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('xtrus-fcm', {
          name: '알림',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250]
        });
      }

      if (Platform.OS === 'ios') {
        await messaging().registerDeviceForRemoteMessages();
      }

      const realFcmToken = await messaging().getToken();

      if (realFcmToken) {
        setFcmToken(realFcmToken);
        await SecureStore.setItemAsync('SAVED_FCM_TOKEN', realFcmToken);
        console.log("FCM 토큰 동기화 완료:", realFcmToken);
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
      // 2. 메일 앱 설정이 안 되어 있다면 친절한 안내창 출력
      Alert.alert(
        "메일 설정 필요",
        "아이폰 'Mail' 앱에 이메일 계정이 등록되어 있지 않습니다.\n\n'Mail'앱에 이메일을 등록하시거나, 아래 토큰을 복사하여 PC에서 메일로 보내주세요.",
        [
          { text: "확인" }
        ]
      );
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

      const geoResponse = await fetch(`https://ipwho.is/${directIp}`);
      const geoData = await geoResponse.json();
      const directCountry = (geoData && geoData.country_code === 'KR') ? 'KR' : 'OTHER';

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
        body: `안녕하세요, 관리자님.<br/>아래 암호화된 텍스트를 복사하여 등록해 주세요.<br/><br/>[ENCRYPTED_DATA]<br/>${encrypted}<br/><br/>감사합니다.`,
        isHtml: true,
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

      const encrypted = CryptoJS.AES.encrypt(rawData, SECRET_KEY, {
        iv: SHARE_IV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }).toString();

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

    Alert.alert(
      "인증 초기화",
      "초기화 시 다시 인증 메일을 발송해야 합니다. 진행하시겠습니까?",
      [
        { text: "취소", style: "cancel", onPress: () => { Keyboard.dismiss() } },
        {
          text: "확인",
          onPress: async () => {
            try {
              await SecureStore.deleteItemAsync(FCM_REGISTERED_KEY);
              await messaging().deleteToken();

              setIsPageLoading(true);

              const newFcmToken = await messaging().getToken();
              if (newFcmToken) {
                setFcmToken(newFcmToken);
                await SecureStore.setItemAsync("SAVED_FCM_TOKEN", newFcmToken);
                console.log("새로운 Fcm 토큰으로 갱신 : ", newFcmToken);
              }
              setIsRegistered(false);
              setIsWaitingAuth(false);
              setIsPageLoading(false);

              Alert.alert("초기화 성공", "새로운 FCM 토큰이 발급되었습니다. 이메일 인증 절차를 다시 진행해주세요.");
            } catch (error) {
              setIsPageLoading(false);
              console.error("토큰 재발급 에러:", error);
              Alert.alert("오류", "초기화 중 문제가 발생했습니다.");
            }
          }
        }
      ],
      { cancelable: true }
    );
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
    //이미 조회된 pushList에 검색어를 적용 하여 보여지는 리스트 구성
    // const displayList = pushList.filter((item) => {
    //   const term = searchKeyword.toLowerCase();
    //   const matchText = !searchKeyword.trim() || (
    //     (item.messageName && item.messageName.toLowerCase().includes(term)) ||
    //     (item.docNumber && item.docNumber.toLowerCase().includes(term)) ||
    //     (item.senderTpId && item.senderTpId.toLowerCase().includes(term)) ||
    //     (item.recverTpId && item.recverTpId.toLowerCase().includes(term))
    //   );

    //   const logDate = item.logTime ? item.logTime.substring(0, 8) : '';
    //   const matchesDate = (
    //     (!startDate || logDate >= startDate) &&
    //     (!endDate || logDate <= endDate)
    //   );

    //   return matchText && matchesDate;
    // });

    //검색 조건 저장
    const saveDateConditions = async () => {
      await AsyncStorage.setItem('START_DATE', startDate);
      await AsyncStorage.setItem('END_DATE', endDate);
      await AsyncStorage.setItem('SEARCH_KEYWORD', searchKeyword);
    };

    // 검색 조건 초기화 (초기화 버튼 호출)
    const clearSearchData = async () => {
      setStartDate('');
      setEndDate('');
      setSearchText('');
      setSearchKeyword('');

      setPage(0);
      setPushList([]);
      setIsListEnd(false);

      await AsyncStorage.removeItem('START_DATE');
      await AsyncStorage.removeItem('END_DATE');
      await AsyncStorage.removeItem('SEARCH_KEYWORD');
    };

    const executeSearch = async () => {

      setIsSearchOpen(false); // 모달 닫기
      Keyboard.dismiss();

      setSearchKeyword(searchText);
      setPage(0);
      setPushList([]);
      setIsListEnd(false);

      await saveDateConditions();

      await fetchMoreData(true, searchText);
    };

    return (
      <SafeAreaView style={styles.listContainer}>
        <View style={styles.headerFull}>
          {/* 1. 배경이 될 로고 이미지 */}
          <Image
            source={require('../../assets/images/top_left.jpg')}
            style={styles.headerLogoFull}
            resizeMode="cover"
          />

          {/* 2. 버튼들을 오른쪽 상단에 위치시킬 절대 좌표 컨테이너 */}
          <View style={styles.headerButtonsOverlay}>
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.iconButton}
              onPress={() => setIsSearchOpen(true)}
            >
              <Ionicons name="search" size={22} color="#ffffff" />
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.8}
              style={styles.resetButtonInline}
              onPress={resetToAuthForm}
            >
              <Text style={styles.resetButtonText}>초기화</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Modal
          visible={isSearchOpen}
          animationType="slide"
          presentationStyle="pageSheet" // iOS에서 위에 살짝 틈이 남는 예쁜 스타일
          onRequestClose={() => setIsSearchOpen(false)}
        >
          <SafeAreaView style={styles.searchModalContainer}>
            {/* 검색창 헤더 */}
            <View style={styles.searchModalHeader}>
              <Text style={styles.searchModalTitle}>상세 검색</Text>
              <TouchableOpacity
                activeOpacity={0.2}
                style={styles.resetButtonInline}
                onPress={clearSearchData}
              >
                <Text style={styles.resetButtonText}>초기화</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setIsSearchOpen(false)} style={styles.closeIconButton}>
                <Ionicons name="close" size={26} color="#1e293b" />
              </TouchableOpacity>
            </View>

            {/* 검색창 본문 */}
            <ScrollView style={styles.searchModalBody} keyboardShouldPersistTaps="handled">

              {/* 1. 텍스트 검색 영역 */}
              <Text style={styles.searchSectionTitle}>검색어</Text>
              <View style={styles.searchModalInputWrapper}>
                <Ionicons name="search" size={18} color="#94a3b8" style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.searchModalInput}
                  placeholder="문서명, 송/수신자, 문서번호 입력"
                  value={searchText}
                  onChangeText={setSearchText}
                  onSubmitEditing={executeSearch} // 키보드 엔터 쳐도 검색 후 닫힘
                  returnKeyType="search"
                  autoFocus={true}
                />
                {searchText.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchText('')} style={{ padding: 4 }}>
                    <Ionicons name="close-circle" size={18} color="#cbd5e1" />
                  </TouchableOpacity>
                )}
              </View>

              <Text style={styles.searchSectionTitle2}>발생 일자 (YYYYMMDD)</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <TextInput
                  style={[styles.searchModalDateInput, { flex: 1 }]}
                  placeholder="시작일"
                  value={startDate}
                  onChangeText={setStartDate}
                  keyboardType="number-pad"
                  maxLength={8}
                />
                <Text style={{ marginHorizontal: 10 }}>~</Text>
                <TextInput
                  style={[styles.searchModalDateInput, { flex: 1 }]}
                  placeholder="종료일"
                  value={endDate}
                  onChangeText={setEndDate}
                  keyboardType="number-pad"
                  maxLength={8}
                />
              </View>

            </ScrollView>

            {/* 검색창 하단 버튼 영역 */}
            <View style={styles.searchModalFooter}>
              <TouchableOpacity
                style={styles.searchModalSubmitButton}
                activeOpacity={0.8}
                onPress={executeSearch} // 버튼 누르면 검색 후 닫힘
              >
                <Text style={styles.searchModalSubmitText}>저장</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </Modal>

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
            keyExtractor={(item) => `${item.id}-${item.logTime}`}
            onEndReached={() => {
              if (!loading && !isListEnd) {
                fetchMoreData(false);
              }
            }}
            onEndReachedThreshold={0.5} // 0.5 정도로 조절 (더 빨리 반응함)
            ListFooterComponent={loading ? <ActivityIndicator size="small" style={{ marginVertical: 20 }} /> : null}
            // 추가: 스크롤이 리스트 컨테이너 내부에 꽉 차게 보장
            contentContainerStyle={{ flexGrow: 1, padding: 16 }}
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

                  <View style={styles.metaContainer}>
                    <Text style={styles.metaText}>• 문서번호 : {item.docNumber || '-'}</Text>
                    <Text style={styles.metaText}>• 송신: {item.senderTpId || 'ANY'}  ➔  수신: {item.recverTpId || 'ANY'}</Text>
                    <Text style={styles.metaText}>• 발생시간 : {formatLogTime(item.logTime || '-')}</Text>
                  </View>
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
                    <Text style={styles.modalLabel}>문서명</Text>
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

                    <Text style={styles.modalLabel}>문서 번호</Text>
                    <Text style={styles.modalInfoText}>{selectedItem.docNumber || '-'}</Text>

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

                    <Text style={styles.modalLabel}>발생 시간</Text>
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
                  fetchMoreData(true);
                  // loadNotificationLogs();
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
            <Text style={styles.copyButtonText}>인증 정보 복사하기</Text>
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
    height: 60,                // 이미지 높이와 동일하게 설정
    width: '100%',
    position: 'relative',      // 자식 요소들이 이 영역 안에서 좌표를 잡게 함
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerLogoFull: {
    width: '100%',             // 이미지 크기 설정
    height: '100%',
  },
  headerButtonsOverlay: {
    position: 'absolute',      // 부모 영역 안에서 자유롭게 배치
    right: 10,                 // 오른쪽에서 16만큼 띄움
    top: 0,                    // 상단 정렬
    bottom: 0,                 // 하단 정렬 (이 둘을 쓰면 세로 중앙 정렬됨)
    flexDirection: 'row',
    alignItems: 'center',      // 버튼들 세로 중앙 정렬
    gap: 12,                   // 버튼 사이 간격
    zIndex: 10,                // 이미지가 버튼을 덮지 않도록 앞쪽으로 배치
  },
  iconButton: {
    padding: 3,
    backgroundColor: '#255F9C',
    borderRadius: 6,
  },
  closeIconButton: {
    padding: 3,
    backgroundColor: '#ffffff',
    borderRadius: 6,
  },
  resetButtonInline: {
    backgroundColor: '#ef4444',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  resetButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },

  searchBarRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    alignItems: 'center',
  },
  searchInputWrapper: {
    flex: 1,
    flexDirection: 'row',
    height: 40,
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  searchInnerIcon: {
    marginRight: 6,
  },
  searchBarInput: {
    flex: 1,
    height: '100%',
    fontSize: 14,
    color: '#1e293b',
    padding: 0, // 네이티브 안드로이드 패딩 초기화
  },
  clearButton: {
    padding: 4,
  },
  searchSubmitButton: {
    marginLeft: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#0284c7',
    borderRadius: 6,
  },
  searchSubmitButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 'bold',
  },

  searchModalContainer: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  searchModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  searchModalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  searchModalBody: {
    flex: 1,
    padding: 20,
  },
  searchSectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#475569',
    marginBottom: 10,
  },
  searchSectionTitle2: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#475569',
    marginBottom: 10,
    marginTop: 20,
  },
  searchModalInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 48,
  },
  searchModalInput: {
    flex: 1,
    fontSize: 15,
    color: '#1e293b',
    height: 35,
    padding: 0,
  },
  searchModalDateInput: {
    flex: 1,
    fontSize: 15,
    color: '#1e293b',
    height: 45,
    padding: 0,
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  datePickerPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    height: 48,
  },
  dateText: {
    fontSize: 15,
    color: '#64748b',
  },
  searchModalFooter: {
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  searchModalSubmitButton: {
    backgroundColor: '#0284c7',
    height: 52,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchModalSubmitText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },

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
  card: { backgroundColor: '#ffffff', padding: 10, borderRadius: 12, marginBottom: 14, borderWidth: 1, borderColor: '#e2e8f0', elevation: 1 },
  errorCard: { borderColor: '#fca5a5', backgroundColor: '#fffdfd' },
  warningCard: { borderColor: '#f0753b', backgroundColor: '#fffdfd' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  msgName: { fontSize: 13, fontWeight: 'bold', color: '#0284c7' },
  errBadge: { backgroundColor: '#ef4444', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  warningBadge: { backgroundColor: '#f0753b', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  normalBadge: { backgroundColor: '#10b981', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  cardBody: { fontSize: 14, color: '#334155', marginBottom: 10, lineHeight: 20 },
  metaContainer: { backgroundColor: '#f8fafc', padding: 10, borderRadius: 6, marginBottom: 6, borderWidth: 0.5, borderColor: '#cbd5e1' },
  metaText: { fontSize: 11, fontWeight: 'bold', color: '#475569', fontFamily: 'monospace', marginBottom: 2 },
  cardTime: { fontSize: 11, color: '#000000', textAlign: 'right', marginTop: 4 },
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