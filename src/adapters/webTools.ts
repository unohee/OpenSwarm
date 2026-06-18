// ============================================
// OpenSwarm - Web tools (web_fetch + web_search)
// ============================================
//
// First-class web capability for the agentic loop, shared by every adapter
// (openrouter/gpt/local) — the `claude -p` harness used to provide this for
// free (INT-1573). The model calls these deliberately, like `bash`.
//
// web_fetch is keyless. web_search has a pluggable backend: Tavily or Brave
// when a key is set, else a keyless (and fragile) DuckDuckGo fallback.

import type { ToolDefinition } from './tools.js';

export const WEB_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its readable text (HTML stripped to text). Use when you already have a URL (docs, a page) and want its content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web and return ranked results (title, url, snippet). Use to find documentation, API usage, library versions, or current facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Max results to return (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
  },
];

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_CHARS = 20_000;
const USER_AGENT = 'OpenSwarm/0.6 (+https://github.com/unohee/openswarm)';

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: { 'User-Agent': USER_AGENT, ...init.headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Fetch a URL → readable text (HTML stripped). Returns an error string on failure (never throws). */
export async function webFetch(url: string): Promise<string> {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return `Invalid URL: ${url} (must start with http:// or https://)`;
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    return `Fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!res.ok) return `Fetch ${url} → HTTP ${res.status} ${res.statusText}`;
  const ctype = res.headers.get('content-type') ?? '';
  const body = await res.text();
  const text = ctype.includes('html') || /^\s*</.test(body) ? htmlToText(body) : body;
  return text.length > MAX_FETCH_CHARS
    ? `${text.slice(0, MAX_FETCH_CHARS)}\n... (truncated, ${text.length} chars total)`
    : text || '(empty response)';
}

interface SearchResult { title: string; url: string; snippet: string }

/** Which search backend is active (for diagnostics). */
export function searchBackend(): 'tavily' | 'brave' | 'duckduckgo' {
  if (process.env.TAVILY_KEY) return 'tavily';
  if (process.env.BRAVE_SEARCH_KEY) return 'brave';
  return 'duckduckgo';
}

/** Search the web → formatted result list. Returns an error string on failure (never throws). */
export async function webSearch(query: string, maxResults = 5): Promise<string> {
  if (typeof query !== 'string' || !query.trim()) return 'Invalid query: a non-empty search query is required.';
  const n = Math.min(Math.max(Number(maxResults) || 5, 1), 10);
  try {
    const backend = searchBackend();
    const results =
      backend === 'tavily' ? await tavilySearch(query, n)
      : backend === 'brave' ? await braveSearch(query, n)
      : await ddgSearch(query, n);
    if (results.length === 0) return `No results for "${query}".`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n');
  } catch (err) {
    const keyed = process.env.TAVILY_KEY || process.env.BRAVE_SEARCH_KEY;
    const hint = keyed ? '' : ' (the keyless DuckDuckGo backend is fragile — set TAVILY_KEY or BRAVE_SEARCH_KEY for reliable search)';
    return `Search failed for "${query}": ${err instanceof Error ? err.message : String(err)}${hint}`;
  }
}

async function tavilySearch(query: string, n: number): Promise<SearchResult[]> {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.TAVILY_KEY, query, max_results: n }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, n).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 300),
  }));
}

async function braveSearch(query: string, n: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_KEY ?? '', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results ?? []).slice(0, n).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: stripTags(r.description ?? '').slice(0, 300),
  }));
}

async function ddgSearch(query: string, n: number): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();

  const results: SearchResult[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < n) {
    results.push({ title: stripTags(m[2]), url: decodeDdgUrl(m[1]), snippet: '' });
  }

  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let i = 0;
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html)) !== null && i < results.length) {
    results[i].snippet = stripTags(sm[1]).slice(0, 300);
    i++;
  }
  return results;
}

function decodeDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}
