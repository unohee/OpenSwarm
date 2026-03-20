#!/bin/bash
# OpenSwarm 브라우저 자동 실행 설치 스크립트

set -e

PROJECT_DIR="/Users/unohee/dev/OpenSwarm"
PLIST_SOURCE="$PROJECT_DIR/scripts/com.intrect.openswarm.browser.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/com.intrect.openswarm.browser.plist"

echo "🌐 OpenSwarm 브라우저 자동 실행 설정 중..."

# 1. LaunchAgent 디렉토리 생성
mkdir -p "$HOME/Library/LaunchAgents"

# 2. plist 파일 복사
echo "📋 plist 파일 복사: $PLIST_TARGET"
cp "$PLIST_SOURCE" "$PLIST_TARGET"

# 3. 기존 설정 언로드 (있다면)
if launchctl list | grep -q "com.intrect.openswarm.browser"; then
    echo "🔄 기존 설정 제거 중..."
    launchctl unload "$PLIST_TARGET" 2>/dev/null || true
fi

# 4. 설정 로드
echo "🚀 설정 로드 중..."
launchctl load "$PLIST_TARGET"

echo "✅ 브라우저 자동 실행 설정 완료!"
echo ""
echo "📌 동작 방식:"
echo "   - 시스템 부팅 후 10초 뒤 http://localhost:3847 자동 실행"
echo "   - 기본 브라우저에서 OpenSwarm 대시보드가 열립니다"
echo ""
echo "🔧 제거 방법:"
echo "   npm run browser:uninstall"
