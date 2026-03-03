# TUI Chat 입력 가이드

OpenSwarm TUI Chat의 개선된 입력 기능 사용법

## ✨ 새로운 기능

### 1. 여러 줄 입력 지원
이제 긴 메시지나 코드를 여러 줄에 걸쳐 입력할 수 있습니다.

**사용법:**
```
안녕하세요            ← 첫 줄
[Shift+Enter]         ← 줄바꿈
한국어 입력           ← 둘째 줄
[Shift+Enter]         ← 줄바꿈
여러 줄 가능합니다    ← 셋째 줄
[Enter]               ← 전송
```

### 2. 한국어 IME 지원 개선
한국어, 일본어, 중국어 등 IME를 사용하는 언어 입력이 자연스럽습니다.

**개선 사항:**
- ✅ 커서 위치가 정확하게 표시됨
- ✅ 조합 중인 글자가 올바르게 보임
- ✅ 백스페이스로 삭제 시 자연스러움
- ✅ 긴 문장 입력 시 줄바꿈 자동

### 3. 더 큰 입력 영역
입력 박스가 3줄 → 5줄로 확대되어 더 많은 내용을 한눈에 볼 수 있습니다.

## ⌨️ 키 바인딩

| 키 | 동작 | 설명 |
|---|---|---|
| `Enter` | 메시지 전송 | 현재 입력된 내용을 Claude에게 전송 |
| `Shift+Enter` | 줄바꿈 | 입력 박스에 새 줄 추가 (전송하지 않음) |
| `Esc` | 입력 초기화 | 입력 박스의 모든 내용 삭제 |
| `Ctrl+C` | 종료 | TUI 종료 (입력 내용이 있으면 먼저 지움) |
| `1-4` | 탭 전환 | 1=Chat, 2=Projects, 3=Tasks, 4=Logs |
| `Tab` / `Shift+Tab` | 탭 순환 | 다음/이전 탭으로 이동 |

## 📝 사용 예시

### 예시 1: 짧은 질문
```
한국어로 설명해줘 [Enter]
```

### 예시 2: 여러 줄 질문
```
다음 내용을 분석해줘: [Shift+Enter]
[Shift+Enter]
1. 파일 구조 [Shift+Enter]
2. 주요 함수 [Shift+Enter]
3. 개선 방향 [Enter]
```

### 예시 3: 코드 포함 메시지
```
이 코드에 문제가 있어: [Shift+Enter]
[Shift+Enter]
function test() { [Shift+Enter]
  console.log("test"); [Shift+Enter]
} [Shift+Enter]
[Shift+Enter]
어떻게 고칠 수 있을까? [Enter]
```

### 예시 4: 명령어 실행
```
/model haiku [Enter]              # 모델 변경
/clear [Enter]                    # 대화 초기화
/help [Enter]                     # 도움말 보기
```

## 🎨 화면 구성

```
┌────────────────────────────────────────────────────┐
│ OpenSwarm │ session-id │ model │ messages │ cost  │ ← 상태바
├────────────────────────────────────────────────────┤
│ 💬 Chat  📁 Projects  ✓ Tasks  📝 Logs           │ ← 탭바
├────────────────────────────────────────────────────┤
│                                                    │
│  ▸ You                                             │
│    안녕하세요                                       │
│                                                    │
│  ▸ Assistant                                       │
│    안녕하세요! 무엇을 도와드릴까요?                  │ ← 채팅 영역
│    123 tokens · $0.0012                            │
│                                                    │
│                                                    │
│                                                    │
├────────────────────────────────────────────────────┤
│ Message (Shift+Enter: newline, Enter: send)       │
│ 여러 줄 입력 가능                                   │
│ 한국어도 잘 됩니다                                  │ ← 입력 박스 (5줄)
│ [커서]                                             │
│                                                    │
├────────────────────────────────────────────────────┤
│ Tab Switch  Enter Send  Shift+Enter Newline ...   │ ← 도움말
└────────────────────────────────────────────────────┘
```

## 🐛 알려진 제한 사항

### blessed 라이브러리 특성
1. **마우스 클릭 편집**: 마우스로 커서 위치 변경 불가 (키보드 화살표만 가능)
2. **복사/붙여넣기**: 터미널 자체 기능 사용 (Ctrl+Shift+C/V)
3. **파일 첨부**: 현재 지원 안 함

### 터미널 환경 차이
- **tmux/screen**: 일부 키 조합이 다르게 동작할 수 있음
- **Windows Terminal**: Shift+Enter가 Enter로 인식될 수 있음
  - 해결: `Alt+Enter` 사용 또는 설정에서 키 바인딩 변경

## 💡 팁

### 1. 긴 코드 입력
```bash
# 파일에서 복사 후 붙여넣기 추천
cat code.py | xclip -selection clipboard  # Linux
pbcopy < code.py                           # macOS

# TUI에서 Ctrl+Shift+V로 붙여넣기
```

### 2. 멀티라인 템플릿 저장
자주 사용하는 프롬프트는 별도 파일로 저장:

```bash
# ~/.openswarm/prompts/analyze.txt
다음 내용을 분석해줘:

1. 코드 품질
2. 성능 이슈
3. 보안 취약점

[분석 내용]
```

### 3. 빠른 명령어 접근
```bash
# alias 등록 (~/.bashrc)
alias oc='npm run chat --prefix /home/unohee/dev/OpenSwarm'
alias oc-model='echo "/model" | oc'
alias oc-clear='echo "/clear" | oc'
```

## 📚 관련 문서

- `docs/TUI-FIXES.md` - 기술적 수정 내역
- `docs/CLI-CHAT.md` - CLI 채팅 전체 가이드
- `~/.openswarm/LOG-CHEATSHEET.md` - 로그 디버깅 가이드

## 🎯 개선 요청

입력 기능에 대한 개선 사항이 있다면:
1. GitHub Issues: https://github.com/anthropics/claude-code/issues
2. Discord: #openswarm-feedback

---

**마지막 업데이트**: 2026-03-03
**버전**: OpenSwarm v0.1.0
