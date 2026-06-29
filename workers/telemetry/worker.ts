// ============================================
// OpenSwarm telemetry collector — Cloudflare Worker → D1
// ============================================
//
// Receives anonymous usage events from the OpenSwarm CLI/daemon and appends them
// to D1 `intrect-telemetry.openswarm_events`. (INT-1992)
//
// Defense in depth: even though the client only sends a flat anonymous payload,
// this worker re-whitelists fields and clamps lengths so nothing unexpected (PII,
// oversized blobs) can be smuggled into the table.

export interface Env {
  DB: D1Database;
}

/** Coerce to a trimmed string of bounded length, or null. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return new Response('bad json', { status: 400 });
    }

    const installId = str(body.installId, 64);
    if (!installId) return new Response('missing installId', { status: 400 });

    // Cloudflare-provided coarse geo (country only — no IP is stored).
    const country = req.headers.get('cf-ipcountry');

    try {
      await env.DB.prepare(
        `INSERT INTO openswarm_events
           (install_id, event, version, platform, arch, node_version, command, adapter, is_error, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          installId,
          str(body.event, 32) ?? 'invoke',
          str(body.version, 32),
          str(body.platform, 16),
          str(body.arch, 16),
          str(body.nodeVersion, 16),
          str(body.command, 32),
          str(body.adapter, 32),
          body.isError ? 1 : 0,
          country && country !== 'XX' ? country.slice(0, 2) : null,
        )
        .run();
    } catch {
      return new Response('db error', { status: 500 });
    }

    return new Response(null, { status: 204 });
  },
};
