/**
 * Fonction serverless Vercel : /api/chat
 *   GET  /api/chat?prompt=...&uid=123[&image_url=URL&model=lumo-max&reasoning=fast|think]
 *   POST /api/chat  body JSON : { prompt, uid?, model?, reasoning?, image_url?,
 *                                images?: [ "data:image/...;base64,..." | "https://..." ] (max 4) }
 *
 * Vision : chaque image peut être une data URL (upload du site) ou une URL
 * http(s) publique (garde SSRF). Retries automatiques sur les backends
 * « aveugles » + consigne système NO_IMAGE (voir lib/lumo.js).
 *
 * Mode serverless : chaque invocation ouvre une session Lumo anonyme neuve.
 * Budget global borné sous le plafond Vercel (maxDuration 60 s, vercel.json).
 */
import { LumoSession, fetchImage, LumoError, DEFAULT_MODEL } from '../lib/lumo.js';

const VERCEL_DEADLINE_MS = 55 * 1000;
const MAX_PROMPT = 20000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 4;

// Garde SSRF : interdit les hôtes privés/locaux pour les images http(s).
const PRIVATE_HOST_RE =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|::ffff:|localhost$|\[::1\])/i;

const json = (res, status, obj) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(obj);
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Prépare une image : data URL passée telle quelle, URL http(s) téléchargée. */
async function prepareImage(value) {
  if (typeof value !== 'string' || !value) throw new LumoError('image invalide (chaîne requise)', { status: 400 });
  if (value.startsWith('data:image/')) {
    const m = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw new LumoError('data URL invalide', { status: 400 });
    const b64 = m[3].trim();
    if (Buffer.from(b64, 'base64').length > MAX_IMAGE_BYTES) throw new LumoError('image trop volumineuse', { status: 413 });
    return { base64: b64, mime: m[1] && m[1].startsWith('image/') ? m[1] : null };
  }
  if (/^https?:/i.test(value)) {
    const host = new URL(value).hostname;
    if (PRIVATE_HOST_RE.test(host)) throw new LumoError('image_url vers un hôte privé interdit', { status: 400 });
    return await fetchImage(value, { maxBytes: MAX_IMAGE_BYTES });
  }
  throw new LumoError('image_url doit être http(s) ou data:image/...', { status: 400 });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { ok: false, error: { message: 'GET ou POST requis', status: 405 } });
  }

  const parsed = new URL(req.url, 'http://localhost');
  const q = parsed.searchParams;

  let prompt = (q.get('prompt') || '').slice(0, MAX_PROMPT);
  let uid = (q.get('uid') || 'default').slice(0, 64);
  let model = (q.get('model') || DEFAULT_MODEL).toLowerCase();
  let reasoning = (q.get('reasoning') || 'fast') === 'think';
  let imageUrl = q.get('image_url') || null;
  let images = null;

  if (req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* corps vide/invalide → {} */ }
    if (body.prompt !== undefined) prompt = String(body.prompt).slice(0, MAX_PROMPT);
    if (body.uid !== undefined) uid = String(body.uid).slice(0, 64);
    if (body.model !== undefined) model = String(body.model).toLowerCase();
    if (body.reasoning !== undefined) reasoning = String(body.reasoning) === 'think' || body.reasoning === true;
    if (body.image_url !== undefined) imageUrl = body.image_url;
    if (Array.isArray(body.images) && body.images.length) images = body.images;
  }

  if (model !== 'lumo-max' && model !== 'lumo' && model !== 'lumo-lite') {
    return json(res, 400, { ok: false, error: { message: "model doit être 'lumo-max' ou 'lumo'", status: 400 } });
  }
  const imageSources = images && images.length ? images : imageUrl ? [imageUrl] : [];
  if (imageSources.length > MAX_IMAGES) {
    return json(res, 400, { ok: false, error: { message: `maximum ${MAX_IMAGES} images par requête`, status: 400 } });
  }
  if (!prompt && imageSources.length === 0) {
    return json(res, 400, { ok: false, error: { message: 'paramètre "prompt" requis (ou image)', status: 400 } });
  }

  const startedAt = Date.now();
  const deadlineMs = Date.now() + VERCEL_DEADLINE_MS;
  try {
    const imageData = [];
    for (const src of imageSources) {
      imageData.push(await prepareImage(src));
    }
    const session = new LumoSession({});
    const out = await session.chat({
      prompt,
      images: imageData.length ? imageData : null,
      model,
      reasoning,
      timeoutMs: 45000,
      visionRetries: imageData.length ? 3 : 0,
      deadlineMs,
    });
    return json(res, 200, {
      ok: true,
      reply: out.content,
      ...(out.reasoning ? { reasoning: out.reasoning } : {}),
      model: model === 'lumo' || model === 'lumo-lite' ? 'lumo' : 'lumo-max',
      uid,
      limits: out.remaining,
      rotations: 0,
      ...(imageData.length ? { vision: { attempts: out.visionAttempts, perceived: !out.blind } } : {}),
      ...(imageData.length && out.blind
        ? { warning: 'Lumo n’a pas perçu l’image (backend multimodal indisponible au moment de l’appel) — réessayez dans quelques secondes.' }
        : {}),
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const status = err instanceof LumoError ? err.status || 502 : 502;
    return json(res, status, {
      ok: false,
      error: { message: err.message || 'Erreur inconnue', status },
      uid,
      duration_ms: Date.now() - startedAt,
      hint: status === 504 || err.name === 'TimeoutError'
        ? 'Délai Vercel dépassé (60 s max) — réessayez, ou déployez en mode serveur local pour les longues réponses.'
        : undefined,
    });
  }
}
