#!/bin/bash
# OpenSwarm macOS launchd 서비스 관리 스크립트

SERVICE_NAME="com.intrect.openswarm"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
LOG_DIR="$HOME/.openswarm/logs"

# 색상 코드
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 서비스 상태 확인
check_status() {
    if launchctl list | grep -q "$SERVICE_NAME"; then
        PID=$(launchctl list | grep "$SERVICE_NAME" | awk '{print $1}')
        if [ "$PID" = "-" ]; then
            echo -e "${YELLOW}⚠️  로드됨 (실행 안됨)${NC}"
            return 2
        else
            echo -e "${GREEN}✅ 실행 중 (PID: $PID)${NC}"
            return 0
        fi
    else
        echo -e "${RED}❌ 서비스 없음${NC}"
        return 1
    fi
}

# 서비스 시작
start_service() {
    echo "▶️  서비스 시작 중..."

    if ! [ -f "$PLIST_PATH" ]; then
        echo -e "${RED}❌ plist 파일 없음: $PLIST_PATH${NC}"
        echo "   먼저 'npm run service:install'을 실행하세요."
        exit 1
    fi

    # 로드되어 있지 않으면 로드
    if ! launchctl list | grep -q "$SERVICE_NAME"; then
        launchctl load "$PLIST_PATH"
    fi

    # 시작
    launchctl start "$SERVICE_NAME"
    sleep 2
    check_status
}

# 서비스 중지
stop_service() {
    echo "⏹️  서비스 중지 중..."
    launchctl stop "$SERVICE_NAME" 2>/dev/null || true
    echo -e "${GREEN}✅ 중지됨${NC}"
}

# 서비스 재시작
restart_service() {
    echo "🔄 서비스 재시작 중..."
    stop_service
    sleep 1
    start_service
}

# 서비스 언로드 (완전 제거)
uninstall_service() {
    echo "🗑️  서비스 언로드 중..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo -e "${GREEN}✅ 언로드됨 (plist 파일은 유지)${NC}"
    echo ""
    echo "plist 파일을 삭제하려면:"
    echo "  rm $PLIST_PATH"
}

# 로그 보기
view_logs() {
    LOG_TYPE="${1:-stdout}"

    if [ "$LOG_TYPE" = "stdout" ]; then
        LOG_FILE="$LOG_DIR/stdout.log"
    elif [ "$LOG_TYPE" = "stderr" ]; then
        LOG_FILE="$LOG_DIR/stderr.log"
    else
        echo -e "${RED}❌ 잘못된 로그 타입: $LOG_TYPE${NC}"
        echo "   사용법: $0 logs [stdout|stderr]"
        exit 1
    fi

    if [ -f "$LOG_FILE" ]; then
        echo -e "${BLUE}📋 로그: $LOG_FILE${NC}"
        echo "───────────────────────────────────────────"
        tail -f "$LOG_FILE"
    else
        echo -e "${YELLOW}⚠️  로그 파일 없음: $LOG_FILE${NC}"
    fi
}

# 상태 보기
show_status() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}OpenSwarm 서비스 상태${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    echo -n "상태: "
    check_status
    STATUS_CODE=$?

    echo ""
    echo "plist: $PLIST_PATH"
    echo "로그: $LOG_DIR/"
    echo ""

    if [ $STATUS_CODE -eq 0 ]; then
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo "최근 로그 (stdout):"
        echo "───────────────────────────────────────────"
        tail -20 "$LOG_DIR/stdout.log" 2>/dev/null || echo "(로그 없음)"
    elif [ $STATUS_CODE -eq 2 ]; then
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo "최근 에러 로그 (stderr):"
        echo "───────────────────────────────────────────"
        tail -20 "$LOG_DIR/stderr.log" 2>/dev/null || echo "(로그 없음)"
    fi
}

# 메인 명령어 처리
case "${1:-status}" in
    start)
        start_service
        ;;
    stop)
        stop_service
        ;;
    restart)
        restart_service
        ;;
    status)
        show_status
        ;;
    uninstall)
        uninstall_service
        ;;
    logs)
        view_logs "${2:-stdout}"
        ;;
    *)
        echo "OpenSwarm 서비스 관리"
        echo ""
        echo "사용법: $0 {start|stop|restart|status|uninstall|logs}"
        echo ""
        echo "명령어:"
        echo "  start       - 서비스 시작"
        echo "  stop        - 서비스 중지"
        echo "  restart     - 서비스 재시작"
        echo "  status      - 상태 및 최근 로그 보기"
        echo "  uninstall   - 서비스 언로드 (제거)"
        echo "  logs [type] - 로그 보기 (stdout|stderr)"
        echo ""
        exit 1
        ;;
esac
