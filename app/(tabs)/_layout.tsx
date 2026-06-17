import { Stack } from 'expo-router';
import React from 'react';

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        // 모든 Stack 화면에서 Expo Router 자체 상단 헤더를 숨깁니다.
        // (index.tsx 내부에 직접 만든 예쁜 SafeAreaView 헤더를 사용하기 때문입니다)
        headerShown: false,
      }}
    >
      {/* 메인 통합 화면인 index만 진입점으로 등록합니다 */}
      <Stack.Screen name="index" />
    </Stack>
  );
}