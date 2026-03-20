#!/bin/bash
# OpenSwarm macOS launchd 서비스 설치 스크립트

set -e

PROJECT_DIR="/Users/unohee/dev/OpenSwarm"
PLIST_SOURCE="$PROJECT_DIR/scripts/com.intrect.openswarm.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/com.intrect.openswarm.plist"
LOG_DIR="$HOME/.openswarm/logs"

echo "📦 OpenSwarm 서비스 설치 중..."

# 1. 프로젝트 빌드 확인
cd "$PROJECT_DIR"
if [ ! -d "dist" ]; then
    echo "⚙️  TypeScript 빌드 중..."
    npm run build
fi

# 2. 로그 디렉토리 생성
echo "📁 로그 디렉토리 생성: $LOG_DIR"
mkdir -p "$LOG_DIR"

# 3. 환경 설정 확인
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "⚠️  .env 파일이 없습니다!"
    echo "   .env.example을 복사하고 설정을 입력하세요:"
    echo "   cp .env.example .env"
    exit 1
fi

if [ ! -f "$PROJECT_DIR/config.yaml" ]; then
    echo "⚠️  config.yaml 파일이 없습니다!"
    echo "   config.example.yaml을 복사하고 설정을 입력하세요:"
    echo "   cp config.example.yaml config.yaml"
    exit 1
fi

# 4. Node.js 경로 확인 및 plist 업데이트
NODE_PATH=$(which node)
echo "🔍 Node.js 경로: $NODE_PATH"

# plist 파일에서 /usr/local/bin/node를 실제 경로로 변경
sed "s|/usr/local/bin/node|$NODE_PATH|g" "$PLIST_SOURCE" > /tmp/openswarm.plist.tmp

# 5. LaunchAgent 디렉토리 생성
mkdir -p "$HOME/Library/LaunchAgents"

# 6. plist 파일 복사
echo "📋 plist 파일 복사: $PLIST_TARGET"
cp /tmp/openswarm.plist.tmp "$PLIST_TARGET"
rm /tmp/openswarm.plist.tmp

# 7. 기존 서비스 언로드 (있다면)
if launchctl list | grep -q "com.intrect.openswarm"; then
    echo "🔄 기존 서비스 중지 중..."
    launchctl unload "$PLIST_TARGET" 2>/dev/null || true
fi

# 8. 서비스 로드
echo "🚀 서비스 로드 중..."
launchctl load "$PLIST_TARGET"

# 9. 서비스 시작
echo "▶️  서비스 시작 중..."
launchctl start com.intrect.openswarm

# 10. 상태 확인
sleep 2
if launchctl list | grep -q "com.intrect.openswarm"; then
    echo "✅ OpenSwarm 서비스 설치 완료!"
    echo ""
    echo "📊 서비스 관리 명령어:"
    echo "   npm run service:status    # 상태 확인"
    echo "   npm run service:start     # 시작"
    echo "   npm run service:stop      # 중지"
    echo "   npm run service:restart   # 재시작"
    echo "   npm run service:logs      # 로그 확인"
    echo ""
    echo "📝 로그 위치:"
    echo "   stdout: $LOG_DIR/stdout.log"
    echo "   stderr: $LOG_DIR/stderr.log"
else
    echo "❌ 서비스 로드 실패. 로그를 확인하세요:"
    echo "   tail -f $LOG_DIR/stderr.log"
    exit 1
fi
