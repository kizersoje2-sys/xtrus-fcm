import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIsFocused } from '@react-navigation/native';
import * as SQLite from 'expo-sqlite';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Button, DeviceEventEmitter, FlatList, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// index.tsx와 동일한 DB 인스턴스 연결
const inDb = SQLite.openDatabaseSync('fcm_history.db') as any;
const formatLogTime = (timeStr: string | undefined | null): string => {
  if (!timeStr) return '날짜 정보 없음';
  
  // 숫자로만 이루어진 17자리 문자열인지 체크 (20260602103734381 형식)
  if (/^\d{17}$/.test(timeStr)) {
    return timeStr.replace(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/,
      '$1-$2-$3 $4:$5:$6:$7'
    );
  }
  
  // 이미 포맷팅되어 있거나created_at 형태라면 그대로 반환
  return timeStr;
};

export default function ExploreScreen() {
  const [pushList, setPushList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [isModalVisible, setIsModalVisible] = useState<boolean>(false);
  const isFocused = useIsFocused(); // 탭 이동 시 화면 포커싱 감지
  const LAST_CLEAN_DATE_KEY = 'LAST_DATABASE_CLEAN_DATE';
  // 사용자가 알림 보관함 탭을 누를 때마다 실행
  useEffect(() => {

    let dbMounded = true;

    const loadCleanDataBase = async () => {
      try{
        if(!inDb){
          console.log('DB 객체가 아직 준비되지 않았습니다.');
          return;
        }

        if(dbMounded && isFocused) {
          loadNotificationLogs();
        }
      }catch(error){
        console.error("보관함 로드 및 청소 중 에서", error);
      }
    };

    loadCleanDataBase();

    const subscription = DeviceEventEmitter.addListener('NewPushDataArrived', () => {
      loadNotificationLogs();
    });
    return () => {subscription.remove(); dbMounded = false;}
  }, [isFocused, inDb]);

  const loadNotificationLogs = async () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const lastCleanDate = await AsyncStorage.getItem(LAST_CLEAN_DATE_KEY);
    
    try {
      setLoading(true);
      
      if(lastCleanDate === todayStr){
        console.log('금일 데이터 삭제는 이미 완료 되었습니다');
        
      } else {
        await inDb.runAsync(`
          DELETE FROM notification_logs 
          WHERE logTime < strftime('%Y%m%d%H%M%S', 'now', '-7 days', 'localtime') || '999'
        `);
        console.log("🧹 1주일 지난 오래된 로그 청소 완료");

        await AsyncStorage.setItem(LAST_CLEAN_DATE_KEY, todayStr);
      }

      const rows: any[] = await inDb.getAllAsync('SELECT * FROM notification_logs ORDER BY id DESC');
      console.log(rows);
      setPushList(rows);

    } catch (error) {
      console.error("❌ 보관함 로드 및 청소 중 에러:", error);
    } finally {
      setLoading(false);
    }
  };

  // 로딩 바 표시
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0284c7" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* 상단 헤더 영역 */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>📊 장애통보 로그 (최신 1주)</Text>
      </View>

      {/* 데이터 유무에 따른 분기 처리 */}
      {pushList.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>수신된 시스템 알림 및 에러 로그가 없습니다.</Text>
        </View>
      ) : (
        <FlatList
          data={pushList}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => {
        
            let cardStyle: any[] = [styles.card];
            // 💡 2. errorType 조건에 따라 스타일을 배열에 추가(push)합니다.
            if (item.errorType === 'E') {
              cardStyle.push(styles.errorCard);   // 에러 스타일 (빨간색 테두리 등)
            } else if (item.errorType === 'W') {
              cardStyle.push(styles.warningCard); // 경고 스타일 (노란색 테두리 등)
            }

            return (
              <TouchableOpacity activeOpacity={0.7} style={cardStyle} onPress={() => {setSelectedItem(item); setIsModalVisible(true);}}>
                {/* 카드 상단 배지 라인 */}
                <View style={styles.cardHeader}>
                  <Text style={styles.msgName}>메세지명: {item.messageName || "UNKNOWN_MSG"}</Text>
                  
                  {/* 💡 4. 배지 텍스트 및 스타일도 errorType 기준으로 3단계 분기 */}
                  {item.errorType === 'E' ? (
                    <Text style={styles.errBadge}>에러: {item.errorCode || 'E'}</Text>
                  ) : item.errorType === 'W' ? (
                    <Text style={styles.warningBadge}>경고: {item.errorCode || 'W'}</Text>
                  ) : (
                    <Text style={styles.normalBadge}>INFO: {item.errorCode || 'I'}</Text>
                  )}
                </View>

                {/* 알림 제목 및 본문 내용 */}
                <Text style={styles.cardBody}>{item.body || item.errorContents}</Text>
                
                {/* 분리된 NotifyMessage 세부 컬럼 메타 정보 표시 영역 */}
                <View style={styles.metaContainer}>
                  <Text style={styles.metaText}>• MessageCtrlId : {item.messageCtrlId || '-'}</Text>
                  <Text style={styles.metaText}>• 송신: {item.senderTpId || 'ANY'}  ➔  수신: {item.recverTpId || 'ANY'}</Text>
                  {item.errorLocation ? <Text style={styles.metaText}>• 위치 : {item.errorLocation}</Text> : null}
                  {item.errorContents ? <Text style={styles.metaText}>• 내용 : {item.errorContents}</Text> : null}
                </View>

                {/* 하단 타임스탬프 */}
                <Text style={styles.cardTime}>
                  로그시간: {formatLogTime(item.logTime || item.created_at)}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
      <Modal 
          animationType='fade'
          transparent={true}
          visible={isModalVisible}
          onRequestClose={() => setIsModalVisible(false)} >
            <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            
            {/* 팝업 헤더 타이틀 */}
            <Text style={styles.modalHeader}>🚨 장애통보 상세 보기</Text>
            
            {/* 스크롤 뷰를 감싸서 내용이 길어져도 안정적으로 독해 가능 */}
            <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={true}>
              {selectedItem && (
                <View style={styles.modalDetailContainer}>
                  
                  <Text style={styles.modalLabel}>Message Name</Text>
                  <Text style={styles.modalValueText}>{selectedItem.messageName || "UNKNOWN_MSG"}</Text>

                  <Text style={styles.modalLabel}>에러 코드 (Error Code)</Text>
                  <Text style={[
                    styles.modalValueText, 
                    selectedItem.errorType === 'E' 
                      ? { color: '#dc3545' } 
                      : selectedItem.errorType === 'W'
                      ? { color: '#f0753b' } 
                      : { color: '#198754' } 
                  ]}>
                    {selectedItem.errorType === 'E' 
                      ? `에러: ${selectedItem.errorCode || 'E'}` 
                      : selectedItem.errorType === 'W'
                      ? `경고: ${selectedItem.errorCode || 'W'}` 
                      : 'INFO (정상)'}
                  </Text>

                  <Text style={styles.modalLabel}>에러 내용 (Contents)</Text>
                  {/* 큰 폰트 크기(17)와 넉넉한 여백 박스로 시원하게 표출 */}
                  <Text style={styles.modalLargeBodyBox}>
                    {selectedItem.errorContents || '내용 없음'}
                  </Text>

                  <Text style={styles.modalLabel}>Message Control ID</Text>
                  <Text style={styles.modalInfoText}>{selectedItem.messageCtrlId || '-'}</Text>

                  <Text style={styles.modalLabel}>송신 ➔ 수신</Text>
                  <Text style={styles.modalInfoText}>
                    {selectedItem.senderTpId || 'ANY'} ➔ {selectedItem.recverTpId || 'ANY'}
                  </Text>

                  {selectedItem.errorLocation && (
                    <>
                      <Text style={styles.modalLabel}>장애 발생 위치 (Location)</Text>
                      <Text style={styles.modalInfoText}>{selectedItem.errorLocation}</Text>
                    </>
                  )}

                  <Text style={styles.modalLabel}>로그 기록 시간</Text>
                  <Text style={styles.modalInfoText}>
                    {formatLogTime(selectedItem.logTime || selectedItem.created_at)}
                  </Text>
                  
                </View>
              )}
            </ScrollView>

            {/* 팝업 닫기 하단 버튼 구역 */}
            <View style={styles.modalButtonContainer}>
              <Button title="닫기" color="#0056b3" onPress={() => setIsModalVisible(false)} />
            </View>

          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9' },
  header: { padding: 16, backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#1e293b' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f4f6f9' },
  emptyText: { color: '#64748b', fontSize: 14 },
  
  // 카드 공통 스타일
  card: { backgroundColor: '#ffffff', padding: 14, borderRadius: 12, marginBottom: 14, borderWidth: 1, borderColor: '#e2e8f0', elevation: 1 },
  // 에러 발생 시 변경될 경고 카드 스타일 (옅은 붉은 기 서리게 설정)
  errorCard: { borderColor: '#fca5a5', backgroundColor: '#fffdfd' },
  warningCard: { borderColor: '#f0753b', backgroundColor: '#fffdfd' },
  
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  msgName: { fontSize: 13, fontWeight: 'bold', color: '#0284c7' },
  
  // 배지 스타일
  errBadge: { backgroundColor: '#ef4444', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  warningBadge: { backgroundColor: '#f0753b', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  normalBadge: { backgroundColor: '#10b981', color: '#ffffff', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#0f172a', marginBottom: 4 },
  cardBody: { fontSize: 14, color: '#334155', marginBottom: 10, lineHeight: 20 },
  
  // 메타 정보 컨테이너 (회색 모노스페이스 박스)
  metaContainer: { backgroundColor: '#f8fafc', padding: 10, borderRadius: 6, marginBottom: 6, borderWidth: 0.5, borderColor: '#cbd5e1' },
  metaText: { fontSize: 11, color: '#475569', fontFamily: 'monospace', marginBottom: 2 },
  
  cardTime: { fontSize: 11, color: '#94a3b8', textAlign: 'right', marginTop: 4 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)', // 뒷배경 어둡게 날리기
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    maxHeight: '80%', // 스마트폰 전체 높이의 80%까지만 확장
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  modalHeader: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#212529',
    borderBottomWidth: 1,
    borderBottomColor: '#e9ecef',
    paddingBottom: 12,
    marginBottom: 16,
  },
  modalScroll: {
    marginBottom: 16,
  },
  modalDetailContainer: {
    gap: 14, // 각 항목 간의 시원시원한 마진 간격 분배
  },
  modalLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#0056b3', // 라벨 명칭은 콤팩트한 블루 톤 처리
  },
  modalValueText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#212529',
  },
  modalLargeBodyBox: {
    fontSize: 17,        // 글씨 크기를 시원시원하게 키움
    color: '#343a40',
    lineHeight: 26,      // 줄간격을 넓혀 빽빽한 시스템 로그가 편하게 읽힘
    backgroundColor: '#f8f9fa', // 옅은 회색 백그라운드 박스로 가독성 영역 분리
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e9ecef',
  },
  modalInfoText: {
    fontSize: 15,
    color: '#495057',
  },
  modalButtonContainer: {
    borderTopWidth: 1,
    borderTopColor: '#e9ecef',
    paddingTop: 12,
  }

});