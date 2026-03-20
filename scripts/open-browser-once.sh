#!/bin/bash
# OpenSwarm 브라우저 1회 실행 스크립트

# 서비스가 완전히 시작될 때까지 대기
sleep 10

# 브라우저 열기
open http://localhost:3847

# 로그 기록
echo "$(date): Opened OpenSwarm dashboard at http://localhost:3847" >> ~/.openswarm/logs/browser.log
