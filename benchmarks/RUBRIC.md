# OpenSwarm 코딩 벤치마크 루브릭 (L0–L6)

OpenSwarm 하네스(worker = `runAgenticLoop`, openrouter 어댑터)의 코딩 능력을 난이도별로
측정하고, 각 난이도에 **비용효율적인 모델**을 데이터로 라우팅하기 위한 루브릭.

> 측정 대상은 **하네스 + 모델**의 결합이다. codex 어댑터(Codex CLI 위임)는 OpenSwarm
> 하네스를 우회하므로 측정에서 제외 — 반드시 openrouter 어댑터로 돈다.

## 난이도 사다리

| Lv | 이름 | 검증하는 능력 | 채점 방식 | 인프라 |
|----|------|--------------|-----------|--------|
| **L0** | 단일 수정 | 한 줄~한 함수 버그픽스 | 정규식 (`check()`) | 즉시 |
| **L1** | 탐색+수정 | 가드 추가, 단순 기능 | 정규식 | 즉시 |
| **L2** | 다중 파일 | 리네임/시그니처 연쇄 (3~4 파일) | 정규식 | 즉시 |
| **L3** | 테스트 통과 | 스텁 구현해 기존 테스트 green | **테스트 실행** (`tsx`) | 즉시 |
| **L4** | 고난도 | 깊은 의존성 연쇄, edge case 완전성, 숨은 버그 추적, 타입 변경 | 테스트 실행 + **tsc** | 즉시 |
| **L5** | 난해 | 알고리즘 정확성(merge-intervals/LRU), 상태기계(tokenizer), 제네릭 타입 | 테스트 실행 | 즉시 |
| **L6** | **실전** | **실제 GitHub 이슈** (SWE-bench Lite) — 대형 repo 탐색 + 근본원인 + 정확한 patch | **공식 swebench 하니스** (Docker) | OrbStack, 분 단위 |

- **L0–L5**: `benchmarks/tasks/codingTasks.ts` (합성, self-contained). 빠른 회귀 테스트.
  `npx tsx benchmarks/modelSelect.ts --repeat N`. 채점은 LLM judge 없는 결정적 방식.
- **L6**: `benchmarks/sweBench.ts`. SWE-bench Lite instance를 OpenSwarm worker가 풀고,
  공식 `swebench.harness.run_evaluation`이 FAIL_TO_PASS+PASS_TO_PASS로 채점.

## 레벨별 추천 모델 (측정 기반)

벤치 데이터(`benchmarks/results/`)로 도출. 점수 = pass_rate → $/pass → tool calls.

| Lv | 추천 worker 모델 | 근거 |
|----|------------------|------|
| L0–L3 | **z-ai/glm-4.7-flash** 또는 deepseek-v4-flash | 100% pass, $0.002~0.004/pass. glm은 2759 tok/s(DeepInfra)로 최속. 경량으로 충분 |
| L4 | 경량 + escalate | 경량 모델도 대부분 통과(100%), 실패 시 frontier escalate |
| L5 | 경량 (일부 실패 감수) | glm/qwen이 L5-lru 등 1~2개 실패(87~95%). escalate가 흡수 |
| **L6** | **frontier (openai/gpt-5)** | **경량은 정답 정확도 부족** — 아래 L6 측정 참조 |

### L6 실측 (pylint-dev__pylint-7080, 2026-06)

| 모델 | patch | 결과 | 비고 |
|------|-------|------|------|
| **openai/gpt-5** | ✅ | **RESOLVED** | `expand_modules.py` 정답 위치 (`os.path.relpath`) |
| gemini-2.5-flash | ✅ | unresolved | `pylinter.py`만 — 정답 위치 빗나감 |
| glm-4.7-flash | ✅ | unresolved | 정답 파일 건드렸으나 부정확 |
| qwen3-coder-30b | ✅ | unresolved | 부정확 |
| deepseek-v4-flash | ❌ | (빈 patch) | 수정 미도달 |
| gpt-5-mini | ❌ | (빈 patch) | 수정 미도달 |

→ **이 instance는 frontier(gpt-5)만 풀었다 (1/6).** 경량 모델은 압축 임계 수정(24k→60k) 후
patch는 생성하지만 **정답 정확도가 frontier에 못 미친다.** SWE-bench Lite는 frontier도
30~50%대 난이도이므로 L6은 frontier 라우팅 + 충분한 maxTurns(80) 필요.

### "검증 강제로 경량을 통과시킬 수 있나?" 실험 (v2, 천장 검증)

검증 루프를 MANDATORY로 강화("edit 후 반드시 run_tests.sh, 실패면 반복")하고 재측정:

| 모델 | v1 (검증 선택) | v2 (검증 강제 + 모든 하네스 수정) |
|------|----------------|----------------------------------|
| gemini-2.5-flash | edit 1, 검증 0 → 틀린 patch | **edit 9 + test 13회 반복** → 그래도 unresolved (FAIL_TO_PASS 0/1, PASS_TO_PASS 120/120 무사) |
| deepseek-v4-flash | edit 0 (압축 수정 전) | **여전히 edit 0** — 80턴 탐색만, 수정 결정 못 내림 |

**결론: 이 난이도의 진단형 버그에서는 사실상 모델 천장.** 검증 강제는 행동을 크게
바꿨지만(blind 제출 → 반복 루프), 정답에 필요한 통찰("재귀 탐색의 절대/상대경로 표현
불일치")은 피드백 13회로도 못 얻었다. 하네스가 줄 수 있는 건 기회(루프·컨텍스트)지
진단 깊이가 아니다.

### 하이브리드 실험: frontier 진단 + 경량 구현 — ✅ 시도한 3 instance 전부 RESOLVED (3/3)

planner/worker 분리 가설을 실측: **gpt-5가 read-only 진단**(root cause + 구체적 fix plan)
→ **경량 모델이 구현 + 검증 루프** → 공식 swebench 채점. **통과 누적 4회** — instance를
바꿔도(5859, 7993), 구현자를 바꿔도(deepseek) 재현된다.

| 구성 | instance | 결과 |
|------|----------|------|
| gemini 단독 (검증 강제, 9 edit + 13 test) | 7080 | unresolved — 진단 실패 |
| **gpt-5 진단(52턴 read-only) + gemini 구현(3 edit + 2 test)** | 7080 | **RESOLVED** ✅ |
| **gpt-5 진단 + deepseek-v4-flash 구현** (단독은 0 edit이던 모델) | 7080 | **RESOLVED** ✅ |
| **gpt-5 진단 + gemini 구현** (새 instance 풀 파이프라인) | 5859 | **RESOLVED** ✅ |
| gpt-5 진단 + glm-4.7-flash | 7080 | 빈 patch — **구현자 부적합** (no-edit 가드 무시, 0 edit) |
| gpt-5 진단 + gemini (v1~v5) | 7993 | unresolved — 1차 진단서의 pseudocode 버그를 구현자가 충실 복제 |
| **gpt-5 재진단(실패 patch+테스트 출력 피드백) + deepseek 구현** | 7993 | **RESOLVED** ✅ |

→ **경량 모델의 L6 천장은 "진단 깊이"이고, 그 부분만 frontier가 메우면 통과한다.**
단 구현자 적합성은 모델별로 갈린다: deepseek ✅✅(기계적 마무리 안정) / gemini ✅(import 누락
등 마무리 변동) / glm ✗.

**재진단 escalate 루프 (7993이 입증한 완성형)**: 1차 진단의 fix plan에 버그가 있으면 경량
구현자는 그것을 충실히 복제한다("trust this analysis" — 신뢰 경계 지침으로도 못 뚫음, 4회
연속). 해법은 구현자 설득이 아니라 **(실패 patch + 테스트 출력)을 들고 frontier 재진단** —
gpt-5는 피드백을 받자 자기 pseudocode의 버그(Formatter.parse literal re-escape 누락)를 정확히
짚었고, deepseek이 그 재진단서로 완주했다. OpenSwarm worker escalate 루프와 동일 구조.
SWE_DIAG_MODEL=openai/gpt-5 + SWE_MODEL=경량으로 실행. 진단은 재사용 가능(SWE_DIAG_FILE) —
같은 instance의 stage 2 재시도 시 frontier 비용 0.

운영 함의: L6급 작업도 "frontier planner가 분석 → 경량 worker가 구현" 분업으로 frontier
full-solve(82턴) 대비 frontier 사용을 진단(52턴 read-only)으로 줄일 수 있다. 경량
구현자는 변동성이 있다(같은 진단으로도 조기 포기 가능) — no-edit 가드(`nudgeMaxOnNoEdit`)와
풍부한 진단(구체적 pseudocode 포함)이 성공 요인. best-of-N은 기대 낮음(진단 없는 gemini
9회 시도 전부 오답).

하이브리드의 추가 결함 모드 (7993에서 발견):
- **진단서 오류 전파**: 진단서 pseudocode 자체에 버그가 있으면(Formatter.parse literal
  re-escape 누락) 구현자가 "trust this analysis" 지시 탓에 그 버그를 충실히 복제한다(3회
  연속 동일 patch). → stage 2 지침에 "THE TEST RESULT OUTRANKS THE PLAN" 신뢰 경계 추가.
- **검증 하네스 자가 해체** (결함 6호): 테스트 실패 원인을 검증 스크립트로 오판해
  run_tests.sh를 5회 수정. → `protectedFiles` 옵션 (edit/write 거부).
- **bash 침묵 타임아웃** (결함 7호): 30초 고정 타임아웃이 docker 경유 테스트에서 출력 없이
  죽어 "환경 고장"으로 오판 유도. → `bashTimeoutMs` 옵션 + 명시적 TIMEOUT 메시지.

## 라우팅 원칙 (티어링)

- **판단 무거운 역할** (Planner/분해, Reviewer): frontier 고정 (gpt-5). 잘못된 판단이
  하류 전체를 오염시키므로 경량화 안 함.
- **실행 역할** (Worker/Tester/Documenter/Auditor): 경량 기본 + 실패 2회 시 frontier escalate.
  - 단 **L6급 실전 작업은 worker도 frontier 권장** — 경량으로는 정답률이 낮다.

## L6 채점 절차

```bash
# 1. OrbStack 사용 (Apple Silicon에서 amd64 에뮬레이션 안정). Docker Desktop은 손상됨.
export DOCKER_HOST="unix:///Users/<you>/.orbstack/run/docker.sock"

# 2. OpenSwarm worker가 instance를 풀어 prediction 생성
OPENROUTER_API=... SWE_MODEL=openai/gpt-5 \
  npx tsx benchmarks/sweBench.ts <instances.json> <preds.json>

# 3. 공식 swebench 하니스로 채점 (per-model, max_workers 1 — 동시 다중은 VM 부하)
/path/swebench-env/bin/python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Lite --predictions_path <preds.json> \
  --run_id <run> --instance_ids <id> --cache_level instance --max_workers 1
```

### L6 함정 (전부 측정으로 확인)
- **OrbStack 필수.** Docker Desktop은 amd64 SWE-bench 워크로드에서 매번 "unable to start"
  503 손상 → 재부팅 필요. OrbStack은 안정적으로 완주.
- 옛 instance는 당대 Python(3.6~3.9) 필수 → 공식 Docker 이미지의 conda env "testbed" 사용.
  naive venv 불가 (`cgi`/`collections.Mapping` 제거).
- requests 옛 instance는 외부 httpbin 의존(503) → 부적합. **순수 로직 repo**(pylint/sympy/
  sphinx) 권장.
- 같은 instance_id를 여러 모델로 한 prediction 파일에 넣으면 마지막 1개만 채점됨 → **모델별
  분리 채점**.
- 이미지 태그: `swebench/sweb.eval.x86_64.<instance_id의 __를 _1776_로>`.

## 하네스 결함 — L6에서 발견·수정 (합성 L0–L5에선 안 드러남)

대형 repo에서만 발현하는 결함 3건을 L6이 잡아냈다:
1. **cwd 미인지**: agenticLoop이 모델에게 작업 디렉터리를 안 알려줘 절대경로 추측 → 탐색 차단.
   → user 프롬프트에 `Working directory: <cwd>` 주입.
2. **bash exit-1 오판**: grep "매치 없음"(exit 1)을 치명 에러로 처리, stdout 미반환 → 무한 반복.
   → 에러 시에도 stdout/stderr+exit code 반환, exit1+무출력은 benign.
3. **압축 무한 루프** (핵심): 긴 작업(60+턴)에서 압축이 읽은 파일을 깎아 무한 재read →
   edit 도달 못 함. → 임계 24k→60k, compactAfterMessages 24→60, keepRecent 8→16.
