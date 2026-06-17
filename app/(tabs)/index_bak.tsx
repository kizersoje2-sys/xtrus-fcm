import CryptoJS from 'crypto-js';
import * as MailComposer from 'expo-mail-composer';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Button, DeviceEventEmitter, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { getOrGenerateDeviceId } from '../../util/deviceId';
//import {Picker} from '@react-native-picker/picker';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, // 화면 상단에 팝업 배너를 띄움
    shouldShowList: true,   // 상태창 내 알림 리스트에 표시함
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});


let inDb: any = null;
const SECRET_KEY = CryptoJS.enc.Utf8.parse('12345678901234567890123456789012'); // 32바이트 (AES-256)
const SHARE_IV = CryptoJS.enc.Utf8.parse('1234567890123456'); // 16바이트
const FCM_REGISTERED_KEY = 'XTRUS_FCM_REGISTERED_STATUS';

//신규 상태 추가


export default function HomeScreen() {
  const [fcmToken, setFcmToken] = useState<string>('');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [isRegistered, setIsRegistered] = useState<boolean>(false); 
  const [isPageLoading, setIsPageLoading] = useState<boolean>(true); // 초기 로딩용
  const [ADMIN_EMAIL, setAdEmail] = useState('');
  // const [emailId, setEmailId] = useState('');          // 이메일 앞자리 ID
  // const [emailDomain, setEmailDomain] = useState('naver.com'); // 선택된 도메인
  // const [customDomain, setCustomDomain] = useState(''); // 직접 입력 시 도메인
  
  const adEmailInputRef = useRef<TextInput>(null);
  const userIdInputRef = useRef<TextInput>(null);


  useEffect(()=> {
       
    const initializeApp = async () => {
      try {
        inDb = SQLite.openDatabaseSync('fcm_history.db');
        await initDB(); 
        registerForPushNotificationsAsync();
        // 기기 고유값 가져오기
        const id = await getOrGenerateDeviceId();
        setDeviceId(id);
        // ⭐️ 기존에 FCM을 한 번이라도 받았었는지 영구 저장소에서 확인
        const registeredStatus = await SecureStore.getItemAsync(FCM_REGISTERED_KEY);
        if (registeredStatus === 'true') {
          setIsRegistered(true);
        }
      } catch (error) {
        console.error('초기화 에러:', error);
      } finally {
        setIsPageLoading(false); // 로딩 해제
      }
    };
    initializeApp();

    const onPushReceived = async (title: string, body: string, data: any) => {
      handlerIncomingPush(title, body, data);
      console.log("푸시 데이터 확인:", data);

      // ⭐️ [핵심] 푸시를 받으면 영구 저장소에 기록하고 화면 상태를 변경합니다.
      if (!isRegistered) {
        await SecureStore.setItemAsync(FCM_REGISTERED_KEY, 'true');
        setIsRegistered(true);
        Alert.alert("인증 완료", "최초 FCM 알림 수신이 확인되어 기기 등록이 완료되었습니다!");
      }
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

    return () => {
      foregroundListener.remove();
      responseListener.remove();
    };
    
  }, []);



  const initDB = async () => {
    try{
      
      if(!inDb){
        console.log('🔄 [initDB] DB 인스턴스가 유실되어 재연결합니다.');
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
    }catch(error){
      console.error('init db fail',  error);
    }
  };

  const handlerIncomingPush = async (title: string, body: string, data: any) => {
    try {
      // 2. 쿼리문 작성 (총 19개 컬럼)
      const query = `
        INSERT INTO notification_logs (
          title, body, logTime, messageName, messageCtrlId,
          senderTpId, senderSvcId, recverTpId, recverSvcId,
          errorPattern, errorType, errorCode, errorContents, errorLocation,
          errorModuleID, useDuplicationCheck, templateID, nodeId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `;

      // 3. 💡 자바의 getter 대신 객체의 Property 점 표기법(data.xxx)으로 값을 매핑합니다.
      // 서버(Spring)에서 데이터가 넘어오지 않아 undefined일 경우를 대비해 '|| ""' (빈값 방어) 처리를 해줍니다.
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

      // 4. 안전하게 파라미터 바인딩하여 쿼리 실행
      await inDb.runAsync(query, params);
      DeviceEventEmitter.emit('NewPushDataArrived');
      console.log(`📥 [성공] 노드(${data.nodeId || '알수없음'})로부터 온 관제 로그 DB 저장 완료!`);

    } catch (error) {
      console.error("❌ 컬럼 분리 DB 저장 중 에러 발생:", error);
    }
  };


  async function registerForPushNotificationsAsync() {
    try{
      const {status: existingStatus} = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if(existingStatus !== 'granted'){
        const {status} = await Notifications.requestPermissionsAsync({
          ios: {
            allowAlert: true,
            allowBadge: true,
            allowSound: true
          }
        });
        finalStatus = status;
      }

      if(finalStatus !== 'granted'){
        Alert.alert('알림 권한', '푸시 알림 권한이 거부되었습니다.');
        return;
      }

      if(Platform.OS === 'android'){
        await Notifications.setNotificationChannelAsync('xtrus-fcm', {
          name: '알림',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0,250,250,250]
        });
      }

      const tokenData = await Notifications.getDevicePushTokenAsync();
      if(tokenData && tokenData.data){
        setFcmToken(tokenData.data);
      }

    }catch(error){
      console.error('토큰 생성 중 오류 발생', error);
      Alert.alert('오류', '토큰을 생성하지 못했습니다');
    }
  }
  
  async function sendEmailWithToken(){
    const isAvailable = await MailComposer.isAvailableAsync();
    const platformStr = Platform.OS === 'android' ? 'AOS_APP' : 'IOS_APP';
    if(!isAvailable){
      Alert.alert('오류', '이메일을 보낼 수 있는 매일 앱이 설정되어 있지 않습니다.');
      return;
    }

    if (!ADMIN_EMAIL.trim()) {
      Alert.alert("알림", "관리자 이메일 주소를 입력해 주세요.", [{text:"확인", onPress: () => {
        setTimeout(()=>{
          adEmailInputRef.current?.focus();
        }, 100);
      }}]);
      return;
    }

    if (!userId.trim()) {
      Alert.alert("알림", "아이디를 입력해 주세요.", [{text:"확인", onPress: () => {
        setTimeout(()=>{
          userIdInputRef.current?.focus();
        }, 100);
      }}]);
      return;
    }

    

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(ADMIN_EMAIL)) {
    Alert.alert(
      "입력 오류", 
      "이메일 주소 형식이 올바르지 않습니다.\n형식(예: user@company.com)을 다시 확인해 주세요."
    );
    return;
  }

    if (!deviceId || !fcmToken) {
      Alert.alert("알림", "기기 정보나 FCM 토큰을 불러오는 중입니다.");
      return;
    }

    try {
      // 1. 데이터 구분자(|)로 결합
      const rawData = `${userId}|${deviceId}|${fcmToken}|${platformStr}`;

      // 2. AES-256-CBC 암호화
      const encrypted = CryptoJS.AES.encrypt(rawData, SECRET_KEY, {
        iv: SHARE_IV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }).toString();
      console.log(encrypted);
      // 3. 이메일 앱 호출
      const result = await MailComposer.composeAsync({
        recipients: [ADMIN_EMAIL],
        subject: 'xTrus FCM TOKEN 암호화 등록 요청',
        body: `안녕하세요, 관리자님.\n아래 암호화된 텍스트를 복사하여 등록해 주세요.\n\n[ENCRYPTED_DATA]\n${encrypted}\n\n감사합니다.`
      });

      if (result.status === MailComposer.MailComposerStatus.SENT) {
        Alert.alert("안내", "이메일 작성 앱이 정상적으로 호출되었습니다.\n앱에서 전송 버튼을 꼭 눌러주세요.");
      }
    } catch (error) {
      Alert.alert("오류", "암호화 및 메일 전송 중 에러가 발생했습니다.");
    }
  }
  if (isPageLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#0056b3" />
      </View>
    );
  }

  // B. ⭐️ FCM을 한 번이라도 받아서 등록이 끝난 상태라면 메인 콘텐츠만 보여줌
  if (!isRegistered) {
    return (
      <View style={styles.container}>
        <Text style={styles.successTitle}>🎉 서비스 이용 기기 등록 완료</Text>
        <Text style={styles.successSub}>정상적으로 FCM 알림을 수신하는 기기입니다.</Text>
        <Text style={styles.successSub}>하단의 장애통보 리스트 탭을 열어 내용 확인 가능합니다.</Text>
        
        {/* 🛠️ 테스트용 임시 초기화 버튼 */}
        <View style={{ marginTop: 40 }}>
          <Button 
            title="기기 등록 상태 초기화" 
            color="#dc3545" 
            onPress={async () => {
              await SecureStore.deleteItemAsync('XTRUS_FCM_REGISTERED_STATUS'); // 저장소 삭제
              setIsRegistered(false); // 상태값 초기화 -> 즉시 메일 화면으로 전환됨
              Alert.alert("알림", "초기화되었습니다. 앱을 재실행하거나 리로드하세요.");
            }} 
          />
        </View>
      </View>
    );
  }

  // C. FCM 받기 전 (이메일 전송 및 대기 화면)
  return (
    <View style={styles.container}>
      <Text style={styles.title}>xTrus 장애통보 기기 등록</Text>
      <Text style={styles.description}>
        최초 1회 관리자에게 이메일을 전송하여 기기를 등록해야 합니다.{"\n"}
        등록 후 테스트 푸시를 받으면 이 화면은 자동으로 사라집니다.
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
        autoCapitalize="none"      // 첫 글자가 자동으로 대문자가 되는 현상 방지
        autoCorrect={false}        // 영문 오타 자동 수정 기능 끄기
        textContentType="emailAddress" // iOS에서 키보드 상단에 이메일 자동완성 추천 활성화
      />
      {/* <View style={styles.container}>
        <Text style={styles.label}>관리자 이메일</Text>
        <View style={styles.emailRow}>
          <TextInput 
            style={styles.idInput}
            placeholder='이메일 아이디'
            value='{emailId}'
            onChangeText={setEmailId}
            autoCapitalize='none'
            keyboardType='email-address'
          />
          <Text 
            style={styles.atText}>@</Text>
          <View 
            style={styles.pickerWrapper}>
              <Picker
                selectedValue={emailDomain}
                onValueChange={(itemValue) => setEmailDomain(itemValue)}
                styles={styles.picker}
                mode="dropdown">
                  <Picker.Item label="naver.com" value="naver.com" />
                  <Picker.Item label="gmail.com" value="gmail.com" />
                  <Picker.Item label="daum.net" value="daum.net" />
                  <Picker.Item label="직접 입력" value="custom" />
              </Picker>
          </View>
        </View>

      </View> */}
      <TextInput 
        ref={userIdInputRef} 
        style={styles.input} 
        value={userId} 
        onChangeText={setUserId} 
        placeholder="사용자 아이디(ID) 입력" 
        autoCapitalize="none"      // 첫 글자가 자동으로 대문자가 되는 현상 방지
        autoCorrect={false}        // 영문 오타 자동 수정 기능 끄기
        textContentType="emailAddress" // iOS에서 키보드 상단에 이메일 자동완성 추천 활성화
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
      </View>

      <Button title="관리자에게 인증 메일 보내기" onPress={sendEmailWithToken} color="#0056b3" />
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#f8f9fa' },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 25, fontWeight: 'bold', color: '#212529', marginBottom: 8 },
  description: { fontSize: 15, color: '#6c757d', lineHeight: 20 },
  descriptionPoint: { fontSize: 14, color: '#e01653', marginBottom: 24, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: '#ced4da', backgroundColor: '#fff', padding: 12, borderRadius: 8, fontSize: 16, marginBottom: 16 },
  infoBox: { 
    padding: 16, 
    backgroundColor: '#e9ecef', 
    borderRadius: 8, 
    marginBottom: 24 
  },
  infoText: { 
    fontSize: 14,             // 크기를 살짝 키워 가독성을 높였습니다.
    fontWeight: '600',        // 텍스트를 약간 두껍게 처리
    color: '#495057', 
    marginBottom: 6 
  },

  // ⭐️ 신규 추가: 상태별 텍스트 색상 스타일
  textSuccess: {
    color: '#198754',         // 성공/준비완료 의미의 진한 초록색
    fontWeight: 'bold',
  },
  textDanger: {
    color: '#dc3545',         // 대기/에러 의미의 진한 빨간색
    fontWeight: 'bold',
  },
  successTitle: { fontSize: 24, fontWeight: 'bold', color: '#198754', textAlign: 'center', marginBottom: 8 },
  successSub: { fontSize: 15, color: '#6c757d', textAlign: 'center' }
});

