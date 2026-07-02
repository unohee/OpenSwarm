import { describe, it, expect } from 'vitest';
import { scanFileContent, aggregateResults, type BsIssue } from './bsDetector.js';

describe('scanFileContent', () => {
  // ============ CRITICAL patterns ============

  describe('critical: empty catch block', () => {
    it('detects catch(e) {} in production code', () => {
      const issues = scanFileContent('try { x() } catch(e) {}', 'src/app.ts', 'typescript');
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('critical');
      expect(issues[0].category).toBe('exception_hiding');
    });

    it('detects catch {} without parameter', () => {
      const issues = scanFileContent('try { x() } catch {}', 'src/app.ts', 'typescript');
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('critical');
    });

    it('excludes empty catch in test files', () => {
      const issues = scanFileContent('try { x() } catch(e) {}', 'src/app.test.ts', 'typescript');
      const catchIssues = issues.filter(i => i.category === 'exception_hiding');
      expect(catchIssues).toHaveLength(0);
    });
  });

  describe('critical: except pass (Python)', () => {
    it('detects except: pass', () => {
      const issues = scanFileContent('except: pass', 'lib/main.py', 'python');
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('critical');
      expect(issues[0].category).toBe('exception_hiding');
    });

    it('detects except Exception: pass', () => {
      const issues = scanFileContent('except Exception: pass', 'lib/main.py', 'python');
      const hiding = issues.filter(i => i.category === 'exception_hiding');
      expect(hiding.length).toBeGreaterThanOrEqual(1);
      expect(hiding[0].severity).toBe('critical');
    });

    it('does not flag except: pass in TypeScript files', () => {
      const issues = scanFileContent('except: pass', 'src/app.ts', 'typescript');
      const hiding = issues.filter(i => i.category === 'exception_hiding');
      expect(hiding).toHaveLength(0);
    });
  });

  describe('critical: hardcoded secrets', () => {
    it('detects hardcoded token assignment', () => {
      const code = 'const token = "sk-1234abcdefgh"';
      const issues = scanFileContent(code, 'src/config.ts', 'typescript');
      const secrets = issues.filter(i => i.category === 'hardcoded_secret');
      expect(secrets).toHaveLength(1);
      expect(secrets[0].severity).toBe('critical');
    });

    it('detects hardcoded api_key', () => {
      const code = "api_key = 'super_secret_key_value'";
      const issues = scanFileContent(code, 'src/service.py', 'python');
      const secrets = issues.filter(i => i.category === 'hardcoded_secret');
      expect(secrets).toHaveLength(1);
    });

    it('excludes token:name pattern (short identifier)', () => {
      // token: 'some_name' with a short value like a config key name
      const code = "token: 'access_token'";
      const issues = scanFileContent(code, 'src/config.ts', 'typescript');
      const secrets = issues.filter(i => i.category === 'hardcoded_secret');
      expect(secrets).toHaveLength(0);
    });

    it('excludes secrets in test files', () => {
      const code = 'const token = "sk-1234abcdefgh"';
      const issues = scanFileContent(code, 'src/auth.test.ts', 'typescript');
      const secrets = issues.filter(i => i.category === 'hardcoded_secret');
      expect(secrets).toHaveLength(0);
    });

    it('flags a hardcoded fallback literal after process.env (still a leaked secret)', () => {
      const code = 'const token = process.env.TOKEN || "sk-fallback1234"';
      const issues = scanFileContent(code, 'src/config.ts', 'typescript');
      const secrets = issues.filter(i => i.category === 'hardcoded_secret');
      expect(secrets).toHaveLength(1);
    });

    it('does not flag pure env reads without a literal fallback', () => {
      const code = 'const token = process.env.TOKEN;';
      const issues = scanFileContent(code, 'src/config.ts', 'typescript');
      const secrets = issues.filter(i => i.category === 'hardcoded_secret');
      expect(secrets).toHaveLength(0);
    });
  });

  describe('critical: debugger statement', () => {
    it('detects debugger statement', () => {
      const issues = scanFileContent('  debugger;', 'src/app.ts', 'typescript');
      const debug = issues.filter(i => i.category === 'debug_leftover' && i.severity === 'critical');
      expect(debug).toHaveLength(1);
    });

    it('detects debugger without semicolon', () => {
      const issues = scanFileContent('debugger', 'src/app.js', 'javascript');
      const debug = issues.filter(i => i.category === 'debug_leftover' && i.severity === 'critical');
      expect(debug).toHaveLength(1);
    });

    it('does not flag debugger in Python files', () => {
      const issues = scanFileContent('debugger', 'src/app.py', 'python');
      const debug = issues.filter(i => i.message.includes('debugger'));
      expect(debug).toHaveLength(0);
    });
  });

  // ============ WARNING patterns ============

  describe('warning: console.log', () => {
    it('detects console.log in production code', () => {
      const issues = scanFileContent('console.log("debug")', 'src/service.ts', 'typescript');
      const logs = issues.filter(i => i.message.includes('console.log'));
      expect(logs).toHaveLength(1);
      expect(logs[0].severity).toBe('warning');
    });

    it('excludes console.log in test files', () => {
      const issues = scanFileContent('console.log("debug")', 'src/service.test.ts', 'typescript');
      const logs = issues.filter(i => i.message.includes('console.log'));
      expect(logs).toHaveLength(0);
    });

    it('excludes console.log in CLI files', () => {
      const issues = scanFileContent('console.log("output")', 'src/cli/run.ts', 'typescript');
      const logs = issues.filter(i => i.message.includes('console.log'));
      expect(logs).toHaveLength(0);
    });
  });

  describe('warning: as any', () => {
    it('detects as any type cast', () => {
      const issues = scanFileContent('const x = foo as any;', 'src/util.ts', 'typescript');
      const casts = issues.filter(i => i.message.includes('as any'));
      expect(casts).toHaveLength(1);
      expect(casts[0].severity).toBe('warning');
    });

    it('excludes as any with eslint-disable comment', () => {
      const code = 'const x = foo as any; // eslint-disable-line';
      const issues = scanFileContent(code, 'src/util.ts', 'typescript');
      const casts = issues.filter(i => i.message.includes('as any'));
      expect(casts).toHaveLength(0);
    });

    it('excludes as any in test files', () => {
      const issues = scanFileContent('const x = foo as any;', 'src/util.test.ts', 'typescript');
      const casts = issues.filter(i => i.message.includes('as any'));
      expect(casts).toHaveLength(0);
    });
  });

  describe('warning: : any type annotation', () => {
    it('detects : any type annotation', () => {
      const issues = scanFileContent('function foo(x: any) {}', 'src/util.ts', 'typescript');
      const anns = issues.filter(i => i.message.includes(': any'));
      expect(anns).toHaveLength(1);
      expect(anns[0].severity).toBe('warning');
    });
  });

  describe('warning: non-null assertion', () => {
    it('detects non-null assertion operator', () => {
      const issues = scanFileContent('const x = obj!.value;', 'src/util.ts', 'typescript');
      const nna = issues.filter(i => i.message.includes('non-null'));
      expect(nna).toHaveLength(1);
      expect(nna[0].severity).toBe('warning');
    });

    it('excludes non-null assertion in test files', () => {
      const issues = scanFileContent('const x = obj!.value;', 'src/util.test.ts', 'typescript');
      const nna = issues.filter(i => i.message.includes('non-null'));
      expect(nna).toHaveLength(0);
    });
  });

  describe('warning: eval()', () => {
    it('detects eval usage', () => {
      const issues = scanFileContent('eval("code")', 'src/run.ts', 'typescript');
      const evals = issues.filter(i => i.message.includes('eval'));
      expect(evals).toHaveLength(1);
      expect(evals[0].severity).toBe('warning');
    });

    it('excludes eval in test files', () => {
      const issues = scanFileContent('eval("code")', 'src/run.test.ts', 'typescript');
      const evals = issues.filter(i => i.message.includes('eval'));
      expect(evals).toHaveLength(0);
    });
  });

  // ============ MINOR patterns ============

  describe('minor: magic numbers', () => {
    it('detects magic numbers (3+ digits)', () => {
      const issues = scanFileContent('if (x === 4096) return;', 'src/calc.ts', 'typescript');
      const magic = issues.filter(i => i.category === 'magic_number');
      expect(magic).toHaveLength(1);
      expect(magic[0].severity).toBe('minor');
    });

    it('excludes magic numbers with const/limit context', () => {
      const issues = scanFileContent('const MAX_SIZE = 4096;', 'src/calc.ts', 'typescript');
      const magic = issues.filter(i => i.category === 'magic_number');
      expect(magic).toHaveLength(0);
    });
  });

  describe('minor: long lines', () => {
    it('detects lines over 200 characters', () => {
      const longLine = 'const x = ' + 'a'.repeat(200) + ';';
      const issues = scanFileContent(longLine, 'src/app.ts', 'typescript');
      const long = issues.filter(i => i.category === 'readability');
      expect(long).toHaveLength(1);
      expect(long[0].severity).toBe('minor');
    });

    it('excludes long import lines', () => {
      const longImport = 'import { ' + 'SomeThing, '.repeat(30) + ' } from "module";';
      const issues = scanFileContent(longImport, 'src/app.ts', 'typescript');
      const long = issues.filter(i => i.category === 'readability');
      expect(long).toHaveLength(0);
    });
  });

  // ============ Line number tracking ============

  it('reports correct line numbers', () => {
    const code = 'line1\nline2\ndebugger;\nline4';
    const issues = scanFileContent(code, 'src/app.ts', 'typescript');
    const debug = issues.filter(i => i.message.includes('debugger'));
    expect(debug).toHaveLength(1);
    expect(debug[0].line).toBe(3);
  });
});

// ============ aggregateResults ============

describe('aggregateResults', () => {
  const makeIssue = (severity: 'critical' | 'warning' | 'minor'): BsIssue => ({
    severity,
    category: 'test',
    message: 'test',
    filePath: 'test.ts',
    line: 1,
    matchedText: 'test',
  });

  it('calculates BS score correctly', () => {
    const issues: BsIssue[] = [
      makeIssue('critical'),   // 10
      makeIssue('warning'),    // 3
      makeIssue('warning'),    // 3
      makeIssue('minor'),      // 1
    ];
    const result = aggregateResults(issues, 5);

    expect(result.critical).toBe(1);
    expect(result.warning).toBe(2);
    expect(result.minor).toBe(1);
    expect(result.filesScanned).toBe(5);
    // (10 + 6 + 1) / 5 = 3.4
    expect(result.bsScore).toBeCloseTo(3.4);
  });

  it('returns 0 score when no files scanned', () => {
    const result = aggregateResults([], 0);
    expect(result.bsScore).toBe(0);
    expect(result.critical).toBe(0);
    expect(result.warning).toBe(0);
    expect(result.minor).toBe(0);
  });

  it('returns 0 score when no issues found', () => {
    const result = aggregateResults([], 10);
    expect(result.bsScore).toBe(0);
    expect(result.filesScanned).toBe(10);
  });

  it('preserves all issues in the result', () => {
    const issues = [makeIssue('critical'), makeIssue('minor')];
    const result = aggregateResults(issues, 1);
    expect(result.issues).toBe(issues);
    expect(result.issues).toHaveLength(2);
  });
});
