// agent-discovery.mjs
// Discover Hermes API gateways by probing /health across a configurable trusted
// host + port range. This backs the "Connected agent" picker in the side panel
// settings and is extracted from sidepanel.js for testability.

import { normalizeGatewayUrl } from './common.mjs';

export const DEFAULT_AGENT_PORTS = Object.freeze([8642, 8643, 8644, 8645, 8646]);
const PROBE_TIMEOUT_MS = 1500;

export function normalizeAgentDiscoveryScheme(value = 'http') {
  return String(value || '').trim().toLowerCase() === 'https' ? 'https' : 'http';
}

export function normalizeAgentDiscoveryHost(value = '127.0.0.1') {
  const raw = String(value || '').trim();
  if (!raw) return '127.0.0.1';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Invalid agent discovery host. Enter a hostname or IP address only.');
  }
  if (parsed.username || parsed.password) throw new Error('Agent discovery host must not include userinfo.');
  const path = parsed.pathname || '/';
  if (path !== '/' || parsed.search || parsed.hash) throw new Error('Agent discovery host must not include a path, query, or fragment.');
  if (parsed.port) throw new Error('Agent discovery host must not include a port. Use Agent ports instead.');
  const host = parsed.hostname || '';
  if (!host) throw new Error('Agent discovery host is missing.');
  if (host.includes(':')) return `[${host.replace(/^\[|\]$/g, '')}]`;
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('Agent discovery host contains unsupported characters.');
  return host;
}

async function probeGatewayModelName(baseUrl, {
  apiKey = '',
  signal,
  fetchFn = globalThis.fetch?.bind(globalThis),
} = {}) {
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const response = await fetchFn(`${baseUrl}/v1/models`, { headers, signal });
    if (!response.ok) return '';
    const payload = await response.json().catch(() => ({}));
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    return String(first?.id || '').trim();
  } catch (_error) {
    return '';
  }
}

export async function probeGatewayHealth(baseUrl, {
  apiKey = '',
  timeoutMs = PROBE_TIMEOUT_MS,
  fetchFn = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (!baseUrl) return { ok: false, error: 'no-url' };
  const normalized = normalizeGatewayUrl(baseUrl);
  const url = `${normalized}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // First probe is intentionally unauthenticated. Only send the user's bearer
    // token after the endpoint identifies itself as Hermes. This prevents a typo
    // or non-Hermes service on a trusted host from receiving the token.
    const response = await fetchFn(url, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    const hermes = response.ok && body.platform === 'hermes-agent';
    let model = body.model || '';
    if (hermes && !model) {
      model = await probeGatewayModelName(normalized, { apiKey, signal: controller.signal, fetchFn });
    }
    return {
      ok: hermes,
      status: response.status,
      version: body.version || '',
      platform: body.platform || '',
      model,
      error: hermes ? '' : (response.ok ? 'not-hermes' : ''),
    };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'error') };
  } finally {
    clearTimeout(timer);
  }
}

export function deriveAgentName(port, probe) {
  if (!probe || !probe.ok) return null;
  if (probe.platform !== 'hermes-agent') return null;
  return probe.model || `agent-${port}`;
}

export async function discoverLocalAgents({
  ports = DEFAULT_AGENT_PORTS,
  apiKey = '',
  host = '127.0.0.1',
  scheme = 'http',
  fetchFn = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (!Array.isArray(ports) || !ports.length) return [];
  const safeHost = normalizeAgentDiscoveryHost(host);
  const safeScheme = normalizeAgentDiscoveryScheme(scheme);
  const candidates = ports.map((port) => ({
    url: `${safeScheme}://${safeHost}:${port}`,
    port,
  }));
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const probe = await probeGatewayHealth(candidate.url, { apiKey, fetchFn });
      return {
        ...candidate,
        ok: probe.ok,
        status: probe.status,
        version: probe.version,
        model: probe.model,
        error: probe.error || '',
        name: deriveAgentName(candidate.port, probe),
      };
    }),
  );
  return results;
}

export function activeAgents(results = []) {
  return results.filter((agent) => agent.ok && agent.name);
}

export function parseAgentPortsInput(value = '') {
  if (typeof value !== 'string') return [];
  const parsed = value
    .split(/[\s,]+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535);
  // de-dupe, preserve order
  const seen = new Set();
  const out = [];
  for (const port of parsed) {
    if (seen.has(port)) continue;
    seen.add(port);
    out.push(port);
  }
  return out;
}

export const AGENT_DISCOVERY_DEFAULTS = Object.freeze({
  ports: [...DEFAULT_AGENT_PORTS],
  host: '127.0.0.1',
  scheme: 'http',
});
