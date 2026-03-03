# TUI Chat Interface Rendering Fixes

## 문제점

1. **줄바꿈 없이 응답 쌓임**: 스트리밍 중 `setLine()`으로 개행 문자가 포함된 긴 텍스트를 한 줄에 넣어서 렌더링 깨짐
2. **tmux에서 화면 깨짐**: 터미널 리사이즈 이벤트를 제대로 처리하지 못함
3. **깜빡임**: 60fps throttle이 너무 빨라서 렌더링이 불안정
4. **한 줄 이상 입력 시 나머지 줄 안 보임**: `textbox`는 single-line만 지원
5. **한국어 입력 부자연스러움**: `textbox`가 IME를 제대로 처리하지 못함

## 수정 사항

### 1. Screen 설정 개선 (`chatTui.ts:238-246`)

```typescript
const screen = blessed.screen({
  smartCSR: true,
  title: 'OpenSwarm Chat',
  fullUnicode: true,
  terminal: 'xterm-256color',
  forceUnicode: true,
  warnings: false,      // ✅ 경고 메시지 억제 (화면 오염 방지)
  dockBorders: true,    // ✅ tmux에서 테두리 처리 개선
  fastCSR: true,        // ✅ 스트리밍 시 빠른 렌더링
});
```

### 2. 스트리밍 렌더링 로직 수정 (`chatTui.ts:638-682`)

**Before (문제):**
```typescript
// setLine()으로 개행 포함 텍스트를 한 줄에 넣음 → 깨짐
const formatted = assistantContent
  .split('\n')
  .map(line => `  ${line}`)
  .join('\n');
ui.chatLog.setLine(headerIdx, `{#34d399-fg}{bold}▸ Assistant{/bold}{/}\n${formatted}`);
```

**After (수정):**
```typescript
// 이전 내용 라인 삭제
for (let i = contentStartLine; i < currentLines; i++) {
  ui.chatLog.deleteLine(contentStartLine);
}

// 라인별로 개별 추가 → 올바른 줄바꿈
const contentLines = assistantContent.split('\n');
for (const line of contentLines) {
  ui.chatLog.log(`  ${line}`);
}
```

**핵심 변경:**
- ❌ `setLine()` 사용 금지 (개행 처리 문제)
- ✅ `deleteLine()` + `log()` 조합으로 라인별 렌더링
- ✅ 각 줄을 개별적으로 추가하여 blessed가 올바르게 줄바꿈 처리

### 3. Throttle 조정 (`chatTui.ts:663`)

```typescript
// Before: 16ms (60fps) - 너무 빨라서 깜빡임
if (now - lastRenderTime < 16) return;

// After: 33ms (30fps) - 부드러운 렌더링
if (now - lastRenderTime < 33) return;
```

### 4. 터미널 리사이즈 핸들러 추가 (`chatTui.ts:982-987`)

```typescript
// tmux/screen에서 터미널 크기 변경 시 재렌더링
process.stdout.on('resize', () => {
  ui.screen.alloc();     // 메모리 재할당
  ui.screen.realloc();   // 버퍼 재할당
  ui.screen.render();    // 화면 재렌더링
});
```

### 5. 입력 박스 개선 - textbox → textarea (`chatTui.ts:391-413`)

**Before (문제):**
```typescript
const inputBox = blessed.textbox({
  height: 3,
  inputOnFocus: true,
  // textbox는 single-line만 지원, 한국어 IME 부자연스러움
});
```

**After (수정):**
```typescript
const inputBox = blessed.textarea({
  height: 5,              // ✅ 더 큰 높이로 여러 줄 지원
  inputOnFocus: true,
  keys: true,             // ✅ 키 핸들링 활성화
  mouse: true,
  scrollable: true,
  alwaysScroll: false,
  // textarea는 multiline + 한국어 IME 지원
});
```

**핵심 변경:**
- ❌ `textbox` (single-line, 한국어 IME 문제)
- ✅ `textarea` (multiline, 한국어 IME 지원)
- ✅ 높이 3 → 5로 증가 (여러 줄 편집 가능)
- ✅ `keys: true`로 키 이벤트 처리 개선

### 6. 키 바인딩 개선 (`chatTui.ts:977-1001`)

```typescript
// Enter: 메시지 전송
ui.inputBox.key(['enter'], async () => {
  const value = ui.inputBox.getValue();
  // ... 전송 로직
});

// Shift+Enter: 줄바꿈 (textarea 기본 동작)
// Escape: 입력 초기화
// Ctrl+C: 종료
```

**사용법:**
- `Enter`: 메시지 전송
- `Shift+Enter`: 줄바꿈 (여러 줄 입력)
- `Esc`: 입력 내용 지우기
- `Ctrl+C`: TUI 종료

### 7. 레이아웃 조정 (`chatTui.ts:292-387`)

```typescript
// 입력 박스 높이가 5줄로 늘어나서 전체 레이아웃 조정
const chatLog = blessed.log({
  height: '100%-9',  // Before: '100%-7', After: '100%-9'
});

const projectsBox = blessed.box({
  height: '100%-9',  // 모든 탭 동일하게 조정
});
```

## 테스트 방법

### 1. 기본 테스트 (터미널)
```bash
npm run chat
# 긴 응답 요청: "한국어로 500자 정도의 긴 답변을 해줘"
```

### 2. tmux 테스트
```bash
tmux new-session -s test-chat
npm run chat
# 화면 크기 조정: Ctrl+B → :resize-pane -U 10
# 긴 응답 요청 후 화면 깨짐 확인
```

### 3. 스트리밍 테스트
```bash
npm run chat
# 프롬프트: "코드베이스 분석 결과를 자세히 설명해줘"
# 스트리밍 중 줄바꿈이 올바르게 되는지 확인
```

## 예상 결과

### ✅ 수정 후
- 스트리밍 응답이 줄바꿈과 함께 자연스럽게 쌓임
- tmux에서 화면 크기 변경 시 자동으로 재렌더링
- 깜빡임 없이 부드러운 스트리밍
- **여러 줄 입력 가능** (Shift+Enter로 줄바꿈)
- **한국어 입력 부드러움** (textarea의 IME 지원)

### ❌ 수정 전
- 응답이 한 줄로 이어붙어서 가로 스크롤 발생
- tmux에서 화면 깨짐
- 깜빡임 심함
- 한 줄만 입력 가능, 나머지 줄 안 보임
- 한국어 입력 시 커서 위치 이상하게 움직임

## 추가 개선 가능 항목

1. **더블 버퍼링**: 렌더링 중 화면 전환을 줄이기 위해 blessed의 double buffering 활성화
2. **lazy rendering**: 보이지 않는 영역은 렌더링 스킵
3. **로그 자동 정리**: 메시지 1000개 초과 시 오래된 메시지 자동 삭제 (메모리 절약)

## 관련 파일

- `src/support/chatTui.ts` - TUI 메인 구현
- `package.json` - `chat` 스크립트
- `docs/CLI-CHAT.md` - 사용법 문서

## 참고

blessed 라이브러리의 `setLine()`은 단일 라인 렌더링용이므로, 개행 문자가 포함된 텍스트는 `log()`로 라인별로 추가해야 합니다.
