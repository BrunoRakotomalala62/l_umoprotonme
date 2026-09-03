/**
 * Fonction serverless Vercel : GET /api/chat
 *   ?prompt=...&uid=123
 *   ?prompt=...&image_url=URL&uid=123        (vision — retries auto)
 *   &model=lumo-max|lumo&reasoning=fast|think
 *
 * Mode serverless : chaque invocation ouvre une session Lumo anonyme neuve
 * (quota 20) — pas d'état partagé entre requêtes. Budget global borné sous le
 * plafond Vercel (maxDuration 60 s dans vercel.json).
 *
 * Déploiement : `npx vercel` à la racine (dépôt public requis sur Hobby).
 */
import { LumoSession, fetchImage, LumoError, DEFAULT_MODEL, sniffMime } from '../lib/lumo.js';

const VERCEL_DEADLINE_MS = 55 * 1000; // marge sous le plafond de 60 s
const MAX_PROMPT = 20000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Garde SSRF : interdit les hôtes privés/locaux pour image_url http(s).
const PRIVATE_HOST_RE =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|::ffff:|localhost$|\[::1\])/i;

const json = (res, status, obj) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(obj);
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: { message: 'GET requis', status: 405 } });

  const parsed = new URL(req.url, 'http://localhost');
  const p = parsed.searchParams;
  const prompt = (p.get('prompt') || '').slice(0, MAX_PROMPT);
  const uid = (p.get('uid') || 'default').slice(0, 64);
  const model = (p.get('model') || DEFAULT_MODEL).toLowerCase();
  const reasoning = (p.get('reasoning') || 'fast') === 'think';
  const imageUrl = p.get('image_url') || null;

  if (model !== 'lumo-max' && model !== 'lumo' && model !== 'lumo-lite') {
    return json(res, 400, { ok: false, error: { message: "model doit être 'lumo-max' ou 'lumo'", status: 400 } });
  }
  if (!prompt && !imageUrl) {
    return json(res, 400, { ok: false, error: { message: 'paramètre "prompt" requis (ou image_url)', status: 400 } });
  }

  // --- image distante : validation + garde SSRF ---
  let imageData = null;
  if (imageUrl) {
    if (!/^(https?:|data:image\/)/i.test(imageUrl)) {
      return json(res, 400, { ok: false, error: { message: 'image_url doit être http(s) ou data:image/...', status: 400 } });
    }
    if (/^https?:/i.test(imageUrl)) {
      let host;
      try { host = new URL(imageUrl).hostname; } catch {
        return json(res, 400, { ok: false, error: { message: 'image_url invalide', status: 400 } });
      }
      if (PRIVATE_HOST_RE.test(host)) {
        return json(res, 400, { ok: false, error: { message: 'image_url vers un hôte privé interdit', status: 400 } });
      }
    }
    try {
      imageData = await fetchImage(imageUrl, { maxBytes: MAX_IMAGE_BYTES });
    } catch (err) {
      return json(res, err.status || 400, { ok: false, error: { message: err.message, status: err.status || 400 } });
    }
  }

  const startedAt = Date.now();
  const deadlineMs = Date.now() + VERCEL_DEADLINE_MS;
  try {
    // Session neuve à chaque invocation (serverless = pas d'état fiable).
    // Vision : 1 seul retry par défaut pour tenir dans le budget de 60 s.
    const session = new LumoSession({});
    const out = await session.chat({
      prompt,
      imageData,
      model,
      reasoning,
      timeoutMs: 45000,
      visionRetries: imageData ? 3 : 0,
      deadlineMs,
    });
    return json(res, 200, {
      ok: true,
      reply: out.content,
      ...(out.reasoning ? { reasoning: out.reasoning } : {}),
      model: model === 'lumo' || model === 'lumo-lite' ? 'lumo' : 'lumo-max',
      uid,
      limits: out.remaining,
      // serverless : rotation non applicable (chaque appel = session neuve)
      rotations: 0,
      ...(imageData ? { vision: { attempts: out.visionAttempts, perceived: !out.blind } } : {}),
      ...(imageData && out.blind
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
