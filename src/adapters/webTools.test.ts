import { afterEach, describe, expect, it, vi } from 'vitest';
import { webFetch, webSearch, searchBackend, WEB_TOOL_DEFINITIONS } from './webTools.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('WEB_TOOL_DEFINITIONS', () => {
  it('exposes exactly web_fetch and web_search', () => {
    expect(WEB_TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual(['web_fetch', 'web_search']);
  });
});

describe('webFetch', () => {
  it('strips HTML to readable text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        '<html><body><h1>Hi</h1><script>bad()</script><p>world &amp; co</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    ));
    const out = await webFetch('https://example.com');
    expect(out).toContain('Hi');
    expect(out).toContain('world & co');
    expect(out).not.toContain('<');
    expect(out).not.toContain('bad()');
  });

  it('rejects a non-http URL without fetching', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const out = await webFetch('ftp://x');
    expect(out).toContain('Invalid URL');
    expect(f).not.toHaveBeenCalled();
  });

  it('reports an HTTP error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })));
    const out = await webFetch('https://example.com/x');
    expect(out).toContain('404');
  });
});

describe('webSearch — backend selection', () => {
  it('defaults to duckduckgo with no keys', () => {
    expect(searchBackend()).toBe('duckduckgo');
  });

  it('prefers Tavily when TAVILY_KEY is set', async () => {
    vi.stubEnv('TAVILY_KEY', 'tk');
    expect(searchBackend()).toBe('tavily');
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://t', content: 'snip' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', f);
    const out = await webSearch('q', 3);
    expect(String(f.mock.calls[0][0])).toContain('api.tavily.com');
    expect(out).toContain('T');
    expect(out).toContain('https://t');
  });

  it('uses Brave when BRAVE_SEARCH_KEY is set', async () => {
    vi.stubEnv('BRAVE_SEARCH_KEY', 'bk');
    expect(searchBackend()).toBe('brave');
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://b', description: 'd' }] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', f);
    const out = await webSearch('q');
    expect(String(f.mock.calls[0][0])).toContain('brave.com');
    expect(out).toContain('B');
  });

  it('parses keyless DuckDuckGo HTML results', async () => {
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fex.com%2Fa">Result A</a>' +
      '<a class="result__snippet">snippet a</a>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })));
    const out = await webSearch('q', 5);
    expect(out).toContain('Result A');
    expect(out).toContain('https://ex.com/a');
    expect(out).toContain('snippet a');
  });

  it('returns an error string (does not throw) on backend failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net down'); }));
    const out = await webSearch('q');
    expect(out).toContain('Search failed');
    expect(out).toContain('TAVILY_KEY'); // keyless hint
  });
});
