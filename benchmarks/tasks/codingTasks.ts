// ============================================
// OpenSwarm - Coding Benchmark Task Set
// Created: 2026-06-09
// Purpose: 모델 라우팅 파레토 측정용 코딩 태스크. 각 태스크는 임시 git repo를
//          만들고(setup), runWorker로 작업시킨 뒤, 객관적 기준(check)으로 채점한다.
//          VEGA benchmarks의 Track A(결정적 매처) 철학을 코딩 도메인에 이식.
// ============================================

export interface BenchTask {
  id: string;
  /**
   * L0=단일 수정, L1=탐색+수정, L2=다중 파일/추론, L3=테스트 통과,
   * L4=고난도(연쇄 의존성/edge case 완전성/숨은 버그 추적),
   * L5=난해(알고리즘 정확성/상태기계/미묘한 경계·타입 — 약한 모델이 실패하는 변별 영역).
   * L6(실전 GitHub 버그, SWE-bench)은 self-contained가 아니라 Docker+공식 채점이 필요해
   * 이 파일이 아니라 `benchmarks/sweBench.ts`가 담당한다. 루브릭 전체는 RUBRIC.md 참조.
   */
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  title: string;
  description: string;
  /** repo 초기 파일 셋 (path → content) */
  files: Record<string, string>;
  /**
   * 채점: 작업 후 repo 상태를 받아 통과 여부 판정. 객관적이어야 한다.
   * - read: repo 내 파일 내용 읽기 (포매팅·구현방식 무관 검증용)
   * - repoDir: repo 절대경로 (테스트 실제 실행 등 행위 검증용)
   * 가능하면 정규식 휴리스틱보다 실행(테스트 통과)으로 채점해 false negative를 피한다.
   */
  check: (
    read: (path: string) => string | null,
    repoDir: string,
  ) => { passed: boolean; reason: string };
}

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

/**
 * 행위 검증 공통 헬퍼: repo 안의 테스트 파일을 실제 실행해 PASS 마커를 확인한다.
 * 정규식 휴리스틱 대비 false negative가 없다(구현 방식과 무관, 통과 여부만 본다).
 */
function runTestFile(repoDir: string, testFile: string): { passed: boolean; reason: string } {
  try {
    const out = execFileSync('npx', ['tsx', testFile], {
      cwd: repoDir,
      timeout: 60_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (out.includes('PASS')) return { passed: true, reason: 'test passed (executed)' };
    return { passed: false, reason: `ran but no PASS marker: ${out.slice(0, 80)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: false, reason: `test failed: ${msg.slice(0, 140)}` };
  }
}

/**
 * 타입체크 검증: repo의 모든 .ts를 strict tsc로 컴파일해 타입 에러가 없는지 본다.
 * 타입 변경 태스크(런타임만으론 검증 불가)에 쓴다. tsx는 타입을 무시하므로 별도 필요.
 */
function runTypeCheck(repoDir: string, includeTests = false): { passed: boolean; reason: string } {
  const files = readdirSync(repoDir).filter(
    (f) => f.endsWith('.ts') && (includeTests || !f.endsWith('.test.ts')),
  );
  try {
    // npx -p typescript 로 명시해 repo-local tsc 부재 시에도 정확한 tsc를 받는다.
    execFileSync('npx', ['-y', '-p', 'typescript@5.6.3', 'tsc', '--noEmit', '--strict', '--skipLibCheck', '--moduleResolution', 'bundler', '--module', 'esnext', '--target', 'es2022', ...files], {
      cwd: repoDir,
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { passed: true, reason: 'typecheck clean' };
  } catch (err) {
    const out = ((err as { stdout?: string }).stdout ?? '') + ((err as { stderr?: string }).stderr ?? '');
    return { passed: false, reason: `typecheck failed: ${(out || String(err)).slice(0, 140)}` };
  }
}

export const CODING_TASKS: BenchTask[] = [
  {
    id: 'L0-fix-multiply',
    level: 'L0',
    title: 'Fix the multiply() bug in calc.ts',
    description:
      'multiply(a, b) in calc.ts currently returns a + b, which is wrong. ' +
      'It must return the product a * b. Fix only multiply; leave add() untouched.',
    files: {
      'calc.ts':
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n\n' +
        '// BUG: multiply adds instead of multiplying\n' +
        'export function multiply(a: number, b: number): number {\n  return a + b;\n}\n',
      'README.md': '# scratch\n\nMath utilities.\n',
    },
    check: (read) => {
      const c = read('calc.ts');
      if (!c) return { passed: false, reason: 'calc.ts missing' };
      const mul = /function multiply[\s\S]*?return\s+a\s*\*\s*b/.test(c);
      const addOk = /function add[\s\S]*?return\s+a\s*\+\s*b/.test(c);
      if (!mul) return { passed: false, reason: 'multiply not fixed to a*b' };
      if (!addOk) return { passed: false, reason: 'add() was altered' };
      return { passed: true, reason: 'multiply=a*b, add intact' };
    },
  },

  {
    id: 'L1-add-null-guard',
    level: 'L1',
    title: 'Add a null/empty guard to parseConfig',
    description:
      'parseConfig(raw) in config.ts calls JSON.parse(raw) directly and throws on ' +
      'null/undefined/empty input. Add a guard: if raw is null, undefined, or an empty ' +
      'string, return an empty object {} instead of throwing. Keep valid JSON parsing intact.',
    files: {
      'config.ts':
        'export function parseConfig(raw: string): Record<string, unknown> {\n' +
        '  return JSON.parse(raw);\n' +
        '}\n',
    },
    check: (read) => {
      const c = read('config.ts');
      if (!c) return { passed: false, reason: 'config.ts missing' };
      // 가드가 있어야 함: raw falsy → {} 반환. 다양한 표현 허용.
      const hasGuard =
        /if\s*\(\s*!raw/.test(c) ||
        /raw\s*===?\s*null/.test(c) ||
        /raw\s*==\s*null/.test(c) ||
        /!raw\s*\|\|/.test(c) ||
        /raw\?\?/.test(c) ||
        /raw\.length\s*===?\s*0/.test(c) ||
        /raw\.trim\(\)/.test(c);
      const returnsEmpty = /\{\s*\}/.test(c); // empty-object literal present somewhere
      const stillParses = /JSON\.parse/.test(c);
      if (!hasGuard) return { passed: false, reason: 'no null/empty guard found' };
      if (!returnsEmpty) return { passed: false, reason: 'no empty-object return' };
      if (!stillParses) return { passed: false, reason: 'JSON.parse removed' };
      return { passed: true, reason: 'guard + empty return + parse intact' };
    },
  },

  {
    id: 'L2-rename-across-files',
    level: 'L2',
    title: 'Rename getUserName to getDisplayName across the module',
    description:
      'Rename the function getUserName to getDisplayName. It is defined in user.ts and ' +
      'called in greet.ts. Update BOTH the definition and the call site so the code stays ' +
      'consistent. Do not change behavior, only the name.',
    files: {
      'user.ts':
        'export function getUserName(id: string): string {\n' +
        '  return `user-${id}`;\n' +
        '}\n',
      'greet.ts':
        "import { getUserName } from './user.js';\n\n" +
        'export function greet(id: string): string {\n' +
        '  return `Hello, ${getUserName(id)}`;\n' +
        '}\n',
    },
    check: (read) => {
      const u = read('user.ts');
      const g = read('greet.ts');
      if (!u || !g) return { passed: false, reason: 'user.ts or greet.ts missing' };
      const defRenamed = /function getDisplayName/.test(u) && !/function getUserName/.test(u);
      const callRenamed = /getDisplayName\(/.test(g) && !/getUserName/.test(g);
      const importRenamed = /import\s*\{\s*getDisplayName\s*\}/.test(g);
      if (!defRenamed) return { passed: false, reason: 'definition not renamed' };
      if (!callRenamed) return { passed: false, reason: 'call site not renamed' };
      if (!importRenamed) return { passed: false, reason: 'import not updated' };
      return { passed: true, reason: 'def + import + call all renamed' };
    },
  },

  {
    id: 'L3-implement-to-pass-test',
    level: 'L3',
    title: 'Implement isPalindrome so the existing test passes',
    description:
      'isPalindrome(s) in palindrome.ts is a stub that always returns false. Implement it ' +
      'so it returns true iff the string reads the same forwards and backwards (case-sensitive, ' +
      'comparing the raw characters). The test file palindrome.test.ts already exists — make it pass. ' +
      'Run the test to verify.',
    files: {
      'palindrome.ts':
        'export function isPalindrome(s: string): boolean {\n' +
        '  return false; // TODO: implement\n' +
        '}\n',
      'palindrome.test.ts':
        "import { isPalindrome } from './palindrome.js';\n" +
        "if (isPalindrome('racecar') !== true) throw new Error('racecar should be palindrome');\n" +
        "if (isPalindrome('hello') !== false) throw new Error('hello is not palindrome');\n" +
        "if (isPalindrome('') !== true) throw new Error('empty is palindrome');\n" +
        "if (isPalindrome('ab') !== false) throw new Error('ab is not palindrome');\n" +
        "console.log('PASS');\n",
    },
    check: (read, repoDir) => {
      const p = read('palindrome.ts');
      if (!p) return { passed: false, reason: 'palindrome.ts missing' };
      // 행위 검증: 실제로 테스트를 실행한다. 구현 방식(reverse/투포인터/재귀)과
      // 무관하게 "테스트가 통과하는가"만 본다 — 정규식 false negative 제거.
      try {
        const out = execFileSync('npx', ['tsx', 'palindrome.test.ts'], {
          cwd: repoDir,
          timeout: 60_000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (out.includes('PASS')) return { passed: true, reason: 'test passed (executed)' };
        return { passed: false, reason: `test ran but no PASS marker: ${out.slice(0, 80)}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { passed: false, reason: `test failed: ${msg.slice(0, 120)}` };
      }
    },
  },

  // ============ L4 — 고난도 (경량 모델 변별용) ============

  {
    id: 'L4-cascading-signature-change',
    level: 'L4',
    title: 'Change formatPrice to take a currency arg, fix ALL call sites',
    description:
      'formatPrice(amount) in money.ts must become formatPrice(amount, currency) where currency ' +
      'is a string like "USD" prepended to the output (e.g. formatPrice(5, "USD") → "USD 5.00"). ' +
      'This function is called in THREE other files: cart.ts, invoice.ts, and receipt.ts. Update the ' +
      'signature AND every call site so all callers pass a sensible currency. The test file checks ' +
      'every module — run it to verify nothing was missed.',
    files: {
      'money.ts':
        'export function formatPrice(amount: number): string {\n' +
        '  return amount.toFixed(2);\n' +
        '}\n',
      'cart.ts':
        "import { formatPrice } from './money.js';\n" +
        'export function cartLine(qty: number, price: number): string {\n' +
        '  return `${qty} x ${formatPrice(price)}`;\n' +
        '}\n',
      'invoice.ts':
        "import { formatPrice } from './money.js';\n" +
        'export function invoiceTotal(sum: number): string {\n' +
        '  return `Total: ${formatPrice(sum)}`;\n' +
        '}\n',
      'receipt.ts':
        "import { formatPrice } from './money.js';\n" +
        'export function receiptLine(label: string, amt: number): string {\n' +
        '  return `${label}: ${formatPrice(amt)}`;\n' +
        '}\n',
      'check.test.ts':
        "import { formatPrice } from './money.js';\n" +
        "import { cartLine } from './cart.js';\n" +
        "import { invoiceTotal } from './invoice.js';\n" +
        "import { receiptLine } from './receipt.js';\n" +
        "if (formatPrice(5, 'USD') !== 'USD 5.00') throw new Error('formatPrice signature/output wrong: ' + formatPrice(5,'USD'));\n" +
        "if (!cartLine(2, 3).includes('USD')) throw new Error('cart.ts call site not updated');\n" +
        "if (!invoiceTotal(9).includes('USD')) throw new Error('invoice.ts call site not updated');\n" +
        "if (!receiptLine('Tax', 1).includes('USD')) throw new Error('receipt.ts call site not updated');\n" +
        "console.log('PASS');\n",
    },
    check: (_read, repoDir) => runTestFile(repoDir, 'check.test.ts'),
  },

  {
    id: 'L4-edge-case-completeness',
    level: 'L4',
    title: 'Implement median() correctly for all edge cases',
    description:
      'Implement median(nums) in stats.ts. The median of a sorted list is the middle value, OR the ' +
      'average of the two middle values when the count is even. Handle: empty array (return 0), ' +
      'single element, even count (average the two middle values), and UNSORTED input (you must sort first — ' +
      'the input is not guaranteed sorted). The test exercises all of these. Run it to verify.',
    files: {
      'stats.ts':
        'export function median(nums: number[]): number {\n' +
        '  return nums[Math.floor(nums.length / 2)]; // naive + wrong for even/unsorted/empty\n' +
        '}\n',
      'stats.test.ts':
        "import { median } from './stats.js';\n" +
        "function eq(a: number, b: number, m: string){ if (!(Math.abs(a-b) <= 1e-9)) throw new Error(m + ' got ' + a); }\n" +
        "eq(median([]), 0, 'empty → 0');\n" +
        "eq(median([5]), 5, 'single');\n" +
        "eq(median([1,2,3]), 2, 'odd sorted');\n" +
        "eq(median([1,2,3,4]), 2.5, 'even → average');\n" +
        "eq(median([3,1,2]), 2, 'UNSORTED odd');\n" +
        "eq(median([4,1,3,2]), 2.5, 'UNSORTED even');\n" +
        "eq(median([7,7,7]), 7, 'duplicates');\n" +
        "console.log('PASS');\n",
    },
    check: (_read, repoDir) => runTestFile(repoDir, 'stats.test.ts'),
  },

  {
    id: 'L4-hidden-bug-debug',
    level: 'L4',
    title: 'Find and fix the bug making the cart total wrong',
    description:
      'cartTotal() in shop.ts returns the wrong total and test.ts fails. The symptom is a wrong number, ' +
      'but the root cause is NOT in cartTotal itself — it is in a helper it calls. Investigate the helpers ' +
      '(applyDiscount, lineSubtotal), find the actual bug, and fix it. Do not just patch cartTotal to mask ' +
      'the symptom — fix the real cause. Run test.ts to verify.',
    files: {
      // 진짜 버그: applyDiscount가 percent를 0-1로 기대하는데 lineSubtotal은 0-100으로 넘긴다.
      // cartTotal 자체는 멀쩡하다 — 증상은 cartTotal에서, 원인은 applyDiscount/호출 규약에서.
      'shop.ts':
        'function lineSubtotal(price: number, qty: number): number {\n' +
        '  return price * qty;\n' +
        '}\n' +
        '// discount is a percentage 0-100 (e.g. 10 = 10% off)\n' +
        'function applyDiscount(amount: number, discount: number): number {\n' +
        '  return amount - amount * discount; // BUG: treats discount as a fraction, not a percent\n' +
        '}\n' +
        'export function cartTotal(price: number, qty: number, discountPercent: number): number {\n' +
        '  return applyDiscount(lineSubtotal(price, qty), discountPercent);\n' +
        '}\n',
      'test.ts':
        "import { cartTotal } from './shop.js';\n" +
        "// 100 * 2 = 200, 10% off → 180\n" +
        "const got = cartTotal(100, 2, 10);\n" +
        "if (Math.abs(got - 180) > 1e-9) throw new Error('expected 180, got ' + got);\n" +
        "// 50 * 1 = 50, 0% off → 50\n" +
        "if (Math.abs(cartTotal(50, 1, 0) - 50) > 1e-9) throw new Error('0% case wrong: ' + cartTotal(50,1,0));\n" +
        "console.log('PASS');\n",
    },
    check: (_read, repoDir) => runTestFile(repoDir, 'test.ts'),
  },

  {
    id: 'L4-deep-dependency-chain',
    level: 'L4',
    title: 'Change the User.id type from number to string across the chain',
    description:
      'User.id is currently a number. Change it to a string everywhere it flows: the User interface ' +
      '(types.ts), the factory makeUser (factory.ts), the lookup findUser (repo.ts which compares ids), ' +
      'and the formatter userLabel (format.ts). Every layer touches the id — update all of them so types ' +
      'stay consistent and the test passes. Run check.test.ts.',
    files: {
      'types.ts': 'export interface User {\n  id: number;\n  name: string;\n}\n',
      'factory.ts':
        "import type { User } from './types.js';\n" +
        'export function makeUser(id: number, name: string): User {\n' +
        '  return { id, name };\n' +
        '}\n',
      'repo.ts':
        "import type { User } from './types.js';\n" +
        'export function findUser(users: User[], id: number): User | undefined {\n' +
        '  return users.find((u) => u.id === id);\n' +
        '}\n',
      'format.ts':
        "import type { User } from './types.js';\n" +
        'export function userLabel(u: User): string {\n' +
        '  return `#${u.id} ${u.name}`;\n' +
        '}\n',
      'check.test.ts':
        "import { makeUser } from './factory.js';\n" +
        "import { findUser } from './repo.js';\n" +
        "import { userLabel } from './format.js';\n" +
        "const u = makeUser('abc', 'Ann');\n" +
        "if (typeof u.id !== 'string') throw new Error('id should be string, got ' + typeof u.id);\n" +
        "const found = findUser([u], 'abc');\n" +
        "if (!found) throw new Error('findUser failed with string id');\n" +
        "if (userLabel(u) !== '#abc Ann') throw new Error('label wrong: ' + userLabel(u));\n" +
        "console.log('PASS');\n",
    },
    // 타입 변경 태스크는 런타임만으로 검증 불가(tsx는 타입을 무시) — tsc 타입체크를
    // 먼저 통과해야 하고(그래야 id:number stub이 string 호출에서 걸림), 그 다음 런타임 테스트.
    check: (_read, repoDir) => {
      // test 파일까지 타입체크에 포함 — stub의 id:number가 string 호출에서 걸리게.
      const typecheck = runTypeCheck(repoDir, true);
      if (!typecheck.passed) return typecheck;
      return runTestFile(repoDir, 'check.test.ts');
    },
  },

  // ============ L5 — 난해 (알고리즘/상태/경계 — 강한 변별) ============

  {
    id: 'L5-merge-intervals',
    level: 'L5',
    title: 'Implement mergeIntervals correctly (overlap + sort + touch)',
    description:
      'Implement mergeIntervals(intervals) in intervals.ts. Given an array of [start, end] pairs, merge ' +
      'all overlapping intervals and return them sorted by start. Tricky cases the test checks: unsorted ' +
      'input, intervals that merely touch (e.g. [1,2] and [2,3] → [1,3]), fully nested intervals, and an ' +
      'empty array. Return [] for empty. Run intervals.test.ts.',
    files: {
      'intervals.ts':
        'export function mergeIntervals(intervals: number[][]): number[][] {\n' +
        '  return intervals; // TODO: implement\n' +
        '}\n',
      'intervals.test.ts':
        "import { mergeIntervals } from './intervals.js';\n" +
        "function eq(a: number[][], b: number[][], m: string){ if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error(m+' got '+JSON.stringify(a)); }\n" +
        "eq(mergeIntervals([]), [], 'empty');\n" +
        "eq(mergeIntervals([[1,3],[2,6],[8,10]]), [[1,6],[8,10]], 'overlap');\n" +
        "eq(mergeIntervals([[1,2],[2,3]]), [[1,3]], 'touching');\n" +
        "eq(mergeIntervals([[1,10],[2,3],[4,5]]), [[1,10]], 'nested');\n" +
        "eq(mergeIntervals([[8,10],[1,3],[2,6]]), [[1,6],[8,10]], 'unsorted');\n" +
        "console.log('PASS');\n",
    },
    check: (_read, repoDir) => runTestFile(repoDir, 'intervals.test.ts'),
  },

  {
    id: 'L5-lru-cache',
    level: 'L5',
    title: 'Implement an LRU cache with capacity eviction',
    description:
      'Implement the LRUCache class in lru.ts with a constructor(capacity), get(key) returning the value ' +
      'or -1 if absent, and put(key, value). On put beyond capacity, evict the LEAST recently used entry. ' +
      'A get OR a put counts as a use (makes the key most-recently-used). The test drives a precise ' +
      'eviction sequence — order matters. Run lru.test.ts.',
    files: {
      'lru.ts':
        'export class LRUCache {\n' +
        '  constructor(capacity: number) { /* TODO */ }\n' +
        '  get(key: number): number { return -1; }\n' +
        '  put(key: number, value: number): void { /* TODO */ }\n' +
        '}\n',
      'lru.test.ts':
        "import { LRUCache } from './lru.js';\n" +
        "const c = new LRUCache(2);\n" +
        "c.put(1, 1); c.put(2, 2);\n" +
        "if (c.get(1) !== 1) throw new Error('get(1) should be 1');\n" +
        "c.put(3, 3); // evicts 2 (1 was just used)\n" +
        "if (c.get(2) !== -1) throw new Error('2 should be evicted');\n" +
        "c.put(4, 4); // evicts 1 (3 and... 1 is LRU now? order: get1, put3, get2(miss), put4 → evict 1)\n" +
        "if (c.get(1) !== -1) throw new Error('1 should be evicted');\n" +
        "if (c.get(3) !== 3) throw new Error('3 should remain');\n" +
        "if (c.get(4) !== 4) throw new Error('4 should remain');\n" +
        "console.log('PASS');\n",
    },
    check: (_read, repoDir) => runTestFile(repoDir, 'lru.test.ts'),
  },

  {
    id: 'L5-tokenizer-state-machine',
    level: 'L5',
    title: 'Implement a tokenizer that respects quoted strings',
    description:
      'Implement tokenize(input) in tokenizer.ts. Split the input on spaces into tokens, BUT text inside ' +
      'double quotes is a single token with the quotes removed, and may contain spaces. Example: ' +
      'tokenize(\'a "b c" d\') → ["a", "b c", "d"]. Also handle: empty input → [], multiple spaces ' +
      'collapse, and an escaped quote \\" inside a quoted string stays a literal quote. Run tokenizer.test.ts.',
    files: {
      'tokenizer.ts':
        'export function tokenize(input: string): string[] {\n' +
        '  return input.split(" "); // TODO: handle quotes, escapes, empties\n' +
        '}\n',
      'tokenizer.test.ts':
        "import { tokenize } from './tokenizer.js';\n" +
        "function eq(a: string[], b: string[], m: string){ if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error(m+' got '+JSON.stringify(a)); }\n" +
        "eq(tokenize(''), [], 'empty');\n" +
        "eq(tokenize('a b c'), ['a','b','c'], 'simple');\n" +
        "eq(tokenize('a \"b c\" d'), ['a','b c','d'], 'quoted');\n" +
        "eq(tokenize('a   b'), ['a','b'], 'multi-space');\n" +
        "eq(tokenize('\"hi \\\\\"there\\\\\"\"'), ['hi \"there\"'], 'escaped quote');\n" +
        "console.log('PASS');\n",
    },
    check: (_read, repoDir) => runTestFile(repoDir, 'tokenizer.test.ts'),
  },

  {
    id: 'L5-generic-groupby',
    level: 'L5',
    title: 'Implement a correctly-typed generic groupBy',
    description:
      'Implement groupBy<T, K>(items, keyFn) in groupby.ts. It groups an array of T by the key returned ' +
      'by keyFn (a string or number), returning a Map<K, T[]> where insertion order within each group is ' +
      'preserved. The signature must be properly generic (no any). The test groups objects and numbers and ' +
      'checks both grouping correctness and that the return is a Map. Run groupby.test.ts.',
    files: {
      'groupby.ts':
        'export function groupBy(items: any, keyFn: any): any {\n' +
        '  return new Map(); // TODO: implement, and make it properly generic (no any)\n' +
        '}\n',
      'groupby.test.ts':
        "import { groupBy } from './groupby.js';\n" +
        "const nums = [1,2,3,4,5,6];\n" +
        "const byParity = groupBy(nums, (n: number) => n % 2 === 0 ? 'even' : 'odd');\n" +
        "if (!(byParity instanceof Map)) throw new Error('must return a Map');\n" +
        "if (JSON.stringify(byParity.get('odd')) !== JSON.stringify([1,3,5])) throw new Error('odd group wrong: ' + JSON.stringify(byParity.get('odd')));\n" +
        "if (JSON.stringify(byParity.get('even')) !== JSON.stringify([2,4,6])) throw new Error('even group wrong');\n" +
        "const people = [{n:'a',age:30},{n:'b',age:30},{n:'c',age:40}];\n" +
        "const byAge = groupBy(people, (p: {age:number}) => p.age);\n" +
        "if (byAge.get(30).length !== 2) throw new Error('age-30 group should have 2');\n" +
        "console.log('PASS');\n",
    },
    check: (_read, repoDir) => runTestFile(repoDir, 'groupby.test.ts'),
  },
];
