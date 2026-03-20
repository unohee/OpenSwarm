#!/bin/bash
# OpenSwarm 브라우저 자동 실행 제거 스크립트

PLIST_PATH="$HOME/Library/LaunchAgents/com.intrect.openswarm.browser.plist"

echo "🗑️  브라우저 자동 실행 제거 중..."

if [ -f "$PLIST_PATH" ]; then
    # 언로드
    launchctl unload "$PLIST_PATH" 2>/dev/null || true

    # 파일 삭제
    rm "$PLIST_PATH"

    echo "✅ 브라우저 자동 실행이 제거되었습니다."
else
    echo "⚠️  설정 파일이 없습니다: $PLIST_PATH"
fi
