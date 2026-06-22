// OPTIONAL embedding backend for semantic memory search. When configured, memory({ search })
// becomes semantic (cosine similarity over text embeddings) on top of the lexical/fuzzy
// match — so "monetization issues" finds a note about "IAP purchase failures" even with no
// shared words. When NOT configured, memory stays purely fuzzy (no network, no change).
//
// The provider is pluggable and OFF by default. Activation is explicit:
//   MEMORY_EMBEDDINGS=openai  +  OPENAI_API_KEY
//   (optional OPENAI_EMBEDDING_MODEL, default text-embedding-3-small; OPENAI_BASE_URL for
//    an Azure/proxy/compatible endpoint).
// CROSS-LANGUAGE (e.g. RU + EN): this is the EMBEDDING MODEL's job, not a storage trick —
// a multilingual model maps both languages into ONE shared vector space, so a Russian query
// finds an English note and vice versa with the SAME single embedding per note (no per-
// language vectors needed). The default text-embedding-3-small/large ARE multilingual; for
// stronger cross-lingual recall set OPENAI_EMBEDDING_MODEL=text-embedding-3-large, or point
// OPENAI_BASE_URL at any OpenAI-compatible multilingual endpoint (e.g. Voyage voyage-3,
// Cohere embed-multilingual-v3, or a local bge-m3 / multilingual-e5 gateway). The LEXICAL
// fallback cannot bridge scripts, so also record bilingual `aliases` (see the memory tool).
// NOTE: with this on, the TEXT of each saved finding is sent to the provider to be embedded
// — a deliberate egress to a third party; leave it off if findings must not leave the boundary.

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_BASE = 'https://api.openai.com/v1';
const EMBED_TIMEOUT_MS = 15000;

/** Cosine similarity of two equal-length numeric vectors (1 = identical direction, 0 = orthogonal). */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * Build an embedder from the environment, or return null when none is configured (the
 * caller then falls back to fuzzy). An embedder is { model, embed(texts) -> Promise<number[][]> }
 * returning one vector per input string, in order.
 */
export function createEmbedder({ env = process.env, logger = (m) => console.error(`[mcp] ${new Date().toISOString()} embeddings ${m}`) } = {}) {
  const provider = String(env.MEMORY_EMBEDDINGS || '').trim().toLowerCase();
  if (!provider || provider === 'off' || provider === 'none' || provider === 'fuzzy') return null;
  if (provider !== 'openai') { logger?.(`unknown MEMORY_EMBEDDINGS='${provider}' — falling back to fuzzy memory search`); return null; }
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) { logger?.('MEMORY_EMBEDDINGS=openai but OPENAI_API_KEY is unset — falling back to fuzzy memory search'); return null; }
  const model = env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;
  const baseUrl = (env.OPENAI_BASE_URL || env.OPENAI_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
  logger?.(`semantic memory search enabled (provider=openai, model=${model})`);
  return {
    kind: 'openai',
    model,
    async embed(texts) {
      const input = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
      if (!input.length) return [];
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), EMBED_TIMEOUT_MS);
      try {
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input }),
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = await res.json();
        // Reorder defensively by the API's index field, then take the raw vectors.
        return (json.data || []).slice().sort((x, y) => (x.index ?? 0) - (y.index ?? 0)).map((d) => d.embedding);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
