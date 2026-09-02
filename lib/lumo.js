// lib/lumo.js — Client anonyme pour Lumo (https://lumo.proton.me/guest)
// Reverse-engineered le 2026-09-02. Endpoint public /api/ai/v1/chat/completions.
// Mode "plaintext" : les messages NON marqués encrypted sont acceptés tels quels
// (texte et images), les chunks de réponse arrivent en clair. Pas de request_key.
// Quotas : 20 messages / session anonyme / catégorie (lite=model "lumo",
// max=model "lumo-max", images). Compteur attaché au cookie Session-Id.
// Rotation de session automatique quand le quota tombe à zéro.
export const API_HOST = 'https://lumo.proton.me';
export const DEFAULT_MODEL = 'lumo-max';

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.124 Safari/537.36';

export class LumoError extends Error {
  constructor(message, { status, code, body, retriable = false } = {}) {
    super(message);
    this.name = 'LumoError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retriable = retriable;
  }
}

function headers(extra = {}) {
  return {
    'user-agent': UA,
    accept: 'application/vnd.protonmail.v1+json',
    'content-type': 'application/json',
    'x-pm-appversion': 'web-lumo@2.0.2.0',
    'x-pm-locale': 'en_US',
    origin: 'https://lumo.proton.me',
    referer: 'https://lumo.proton.me/guest/',
    ...extra,
  };
}

// --- Découpage SSE (événements `data:` séparés par lignes vides) ---
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload && payload !== '[DONE]') yield payload;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function sniffMime(base64) {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  if (base64.startsWith('Qk')) return 'image/bmp';
  return 'image/png';
}

/**
 * Une session Lumo anonyme = un cookie Session-Id + quota restant par catégorie.
 */
const BLIND_RE = /(?:ne peux|parviens pas|cannot|can'?t|n['’]ai pas (?:accès|reçu)|pas (?:arrivée|parvenue|transmise|fournie)|aucune donn|rien (?:vu|voir)|pas de contenu visuel|n['’]est pas parvenue).{0,80}(?:image|contenu|voir|visualiser)|(?:voir|visualiser).{0,40}(?:aucune donn|rien|pas)/i;

export function looksBlind(text) {
  if (!text) return false;
  const head = text.slice(0, 400);
  return BLIND_RE.test(head);
}

export class LumoSession {
  constructor({ cookie = '', remaining = null } = {}) {
    this.cookie = cookie;
    this.remaining = remaining || { lite: 20, max: 20, images: 20 };
    this.lastUsage = null;
    this.rotations = 0;
  }

  _mergeSetCookie(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const parts = [];
    for (const sc of setCookies) {
      const name = sc.split('=')[0].trim();
      if (name === 'Session-Id' || name === 'Tag') parts.push(sc.split(';')[0]);
    }
    if (parts.length) this.cookie = parts.join('; ');
  }

  _cookieHeader() {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  /**
   * @param {object} opts { prompt, imageData:{base64,mime}|null, model:'lumo-max'|'lumo', reasoning:boolean, onChunk,
   *                       visionRetries:number (defaut 2) — réessaie si le backend renvoie une réponse "aveugle" }
   * @returns {Promise<{content, reasoning, usage, remaining, appliedCategory, visionAttempts}>}
   */
  async chat({ prompt = '', imageData = null, model = 'lumo-max', reasoning = false, onChunk = null, timeoutMs = 120000, visionRetries = 2, deadlineMs = null } = {}) {
    const resolved = model === 'lumo' || model === 'lumo-lite' ? 'lumo' : 'lumo-max';
    const attempts = imageData ? [0, 1, 2].slice(0, visionRetries + 1) : [0];

    // Dispositions essayées pour la vision (le backend multimédia de Lumo est
    // attribué au hasard : certaines réponses "ne voient pas" l'image).
    // 0 : [text, image]  1 : [image, text]  2 : [image] puis [texte] (2 tours)
    const buildMessages = (attempt) => {
      const imgPart = imageData ? [{ type: 'image_url', image_url: { url: `data:${imageData.mime || sniffMime(imageData.base64)};base64,${imageData.base64}` } }] : [];
      const text = prompt || '';
      if (!imageData) return [{ role: 'user', content: text }];
      const textPart = text ? { type: 'text', text } : null;
      if (attempt === 0) {
        return [{ role: 'user', content: textPart ? [textPart, ...imgPart] : imgPart }];
      }
      if (attempt === 1) {
        return [{ role: 'user', content: textPart ? [...imgPart, textPart] : imgPart }];
      }
      return [
        { role: 'user', content: imgPart },
        ...(text ? [{ role: 'user', content: text }] : []),
      ];
    };

    let last = null;
    for (let i = 0; i < attempts.length; i++) {
      if (deadlineMs && Date.now() >= deadlineMs) break;
      const perTry = deadlineMs ? Math.max(5000, Math.min(timeoutMs, deadlineMs - Date.now())) : timeoutMs;
      const body = {
        model: resolved,
        messages: buildMessages(attempts[i]),
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: reasoning ? 'high' : 'none',
        lumo: { client_type: 'frontend' },
      };

      const res = await fetch(`${API_HOST}/api/ai/v1/chat/completions`, {
        method: 'POST',
        headers: headers(this._cookieHeader()),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(perTry),
      });
      this._mergeSetCookie(res);

      if (!res.ok) {
        let code = null; let raw = null;
        try { raw = await res.text(); const j = JSON.parse(raw); code = j.error?.code ?? j.Code ?? null; } catch { /* ignore */ }
        throw new LumoError(`Lumo upstream ${res.status}`, { status: res.status, code, body: raw, retriable: res.status === 429 || res.status >= 500 });
      }

      let content = '';
      let reasoningText = '';
      let usage = null;
      for await (const payload of sseEvents(res)) {
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        const delta = ev.choices?.[0]?.delta;
        if (delta) {
          if (typeof delta.reasoning === 'string' && delta.reasoning) { reasoningText += delta.reasoning; onChunk?.({ reasoning: delta.reasoning }); }
          if (typeof delta.content === 'string' && delta.content) { content += delta.content; onChunk?.({ content: delta.content }); }
        }
        if (ev.usage) usage = ev.usage;
      }
      this.lastUsage = usage;
      last = { content, reasoning: reasoningText, usage, attempt: attempts[i], blind: looksBlind(content) };
      const applied = usage?.applied_limit_category || (resolved === 'lumo-max' ? 'max' : 'lite');
      if (usage?.remaining_limits) {
        const rl = usage.remaining_limits;
        this.remaining = {
          lite: Number.isInteger(rl.lite) ? rl.lite : this.remaining.lite,
          max: Number.isInteger(rl.max) ? rl.max : this.remaining.max,
          images: Number.isInteger(rl.images) ? rl.images : this.remaining.images,
        };
      } else {
        this.remaining[applied] = Math.max(0, (this.remaining[applied] ?? 1) - 1);
      }
      last.appliedCategory = applied;
      // Pas d'image, ou réponse qui semble avoir vu l'image -> on garde ce résultat
      if (!imageData || !last.blind || i === attempts.length - 1) break;
      onChunk?.({ retry: i + 1 });
    }

    return { ...last, remaining: { ...this.remaining }, visionAttempts: imageData ? attempts.length : 0 };
  }
}

/** Convertit une image distante (URL http(s) ou data:) en {base64, mime, bytes}. */
export async function fetchImage(url, { maxBytes = 10 * 1024 * 1024, timeoutMs = 20000 } = {}) {
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw new LumoError('data URL invalide', { status: 400 });
    const b64 = m[3].trim();
    return { base64: b64, mime: (m[1] && m[1].startsWith('image/')) ? m[1] : sniffMime(b64), bytes: Buffer.from(b64, 'base64').length };
  }
  if (!/^https?:\/\//i.test(url)) throw new LumoError('image_url doit être http(s) ou data:', { status: 400 });
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (err) {
    throw new LumoError(`image inaccessible: ${err.cause?.code || err.message}`, { status: 400 });
  }
  if (!res.ok) throw new LumoError(`fetch image: HTTP ${res.status}`, { status: 400 });
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new LumoError('image trop volumineuse', { status: 413 });
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new LumoError('image trop volumineuse', { status: 413 });
  const b64 = Buffer.from(ab).toString('base64');
  const ct = (res.headers.get('content-type') || '').split(';')[0];
  return { base64: b64, mime: ct.startsWith('image/') ? ct : sniffMime(b64), bytes: ab.byteLength };
}

/**
 * Pool de sessions par uid : un uid = une session Lumo. Quand le quota de la
 * catégorie est épuisé, la session est remplacée (cookie neuf = quota neuf).
 */
export class SessionPool {
  constructor({ maxSessions = 1000 } = {}) {
    this.sessions = new Map();
    this.uidRotations = new Map();
    this.maxSessions = maxSessions;
  }
  _get(uid, create = true) {
    let s = this.sessions.get(uid);
    if (!s && create) {
      s = new LumoSession({});
      this.sessions.set(uid, s);
      if (this.sessions.size > this.maxSessions) {
        const oldest = this.sessions.keys().next().value;
        this.sessions.delete(oldest);
        this.uidRotations.delete(oldest);
      }
    }
    return s;
  }
  _rotate(uid) {
    this.sessions.set(uid, new LumoSession({}));
    this.uidRotations.set(uid, (this.uidRotations.get(uid) || 0) + 1);
  }
  rotationsFor(uid) {
    return this.uidRotations.get(uid) || 0;
  }
  async chat({ uid = 'default', ...opts }) {
    const cat = (opts.model === 'lumo' || opts.model === 'lumo-lite') ? 'lite' : 'max';
    for (let attempt = 0; attempt < 3; attempt++) {
      let session = this._get(uid);
      if ((session.remaining[cat] ?? 0) <= 0) this._rotate(uid);
      try {
        session = this._get(uid);
        const out = await session.chat(opts);
        const exhausted = (session.remaining[cat] ?? 0) <= 0;
        const rotations = this.rotationsFor(uid);
        if (exhausted) this._rotate(uid);
        return { ...out, uid, rotations };
      } catch (err) {
        if (err instanceof LumoError && err.status === 429 && attempt < 2) {
          this._rotate(uid);
          continue;
        }
        throw err;
      }
    }
    throw new LumoError('trop de tentatives', { status: 502 });
  }
  limits(uid = 'default') {
    const s = this.sessions.get(uid);
    return s ? { ...s.remaining, rotations: this.rotationsFor(uid) } : { lite: 20, max: 20, images: 20, rotations: 0 };
  }
  status() { return { sessions: this.sessions.size, cap: this.maxSessions }; }
}

export default { LumoSession, SessionPool, fetchImage, LumoError, DEFAULT_MODEL };
