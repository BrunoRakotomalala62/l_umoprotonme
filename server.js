// server.js — API REST anonyme pour Lumo (https://lumo.proton.me/guest)
//   GET  /api/chat?prompt=...&uid=123[&image_url=...&model=&reasoning=&stream=1]
//   POST /api/chat  { prompt, uid, model, reasoning, image_url, images: [...] }
//   GET  /api/limits?uid=123
//   GET  /health
// Zéro dépendance — Node.js >= 18 (fetch + WebCrypto natifs).
// C'est ce fichier qui tourne sur Render (Docker) et sur le preset « serveur »
// du projet Vercel (package.json main). Les fonctions api/*.js sont le mode
// serverless Vercel (routes /api/chat fonction isolée).
import http from 'node:http';
import { URL } from 'node:url';
import { SessionPool, fetchImage, LumoError, DEFAULT_MODEL } from './lib/lumo.js';

const PORT = process.env.PORT || 3000;
const MAX_PROMPT = 20000; // caractères
const MAX_IMAGE_BYTES = parseInt(process.env.MAX_IMAGE_BYTES || String(10 * 1024 * 1024), 10);
const MAX_IMAGES = 4;
const pool = new SessionPool();

// Garde SSRF : interdit les hôtes privés/locaux pour les images http(s).
const PRIVATE_HOST_RE =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|::ffff:|localhost$|\[::1\])/i;

const html = `<!doctype html><meta charset="utf-8"><title>Lumo API</title>
<style>body{font:15px/1.6 system-ui;max-width:860px;margin:40px auto;padding:0 16px;color:#222}
code{background:#f2f2f7;padding:2px 6px;border-radius:6px;font-size:.92em}
pre{background:#f7f7fa;padding:14px;border-radius:10px;overflow:auto}
h1{font-size:1.6em}</style>
<h1>🔒 Lumo API — proxy REST anonyme</h1>
<p>Pont HTTP vers le chat guest de <b>Lumo</b> (Proton). Sans compte, sans clé API.
Réponses en JSON. Quota Lumo : 20 messages/session/catégorie — le proxy
<b>alterne automatiquement de session</b> quand le quota est épuisé.</p>
<h2>Chat texte</h2>
<pre>GET /api/chat?prompt=bonjour%20comment%20%C3%A7a%20va%3F&uid=123</pre>
<h2>Chat vision (décrire une photo)</h2>
<pre>GET /api/chat?prompt=d%C3%A9cris%20cette%20photo&image_url=https%3A%2F%2Fexemple.com%2Fphoto.jpg&uid=123</pre>
<h2>Upload d'image (site web)</h2>
<pre>POST /api/chat   {"prompt":"décris","uid":"123","images":["data:image/jpeg;base64,…"]}</pre>
<h2>Quota restant d'un uid</h2>
<pre>GET /api/limits?uid=123</pre>
<h2>Paramètres</h2>
<pre><b>prompt</b>     texte (requis sauf si image seule)
<b>uid</b>        identifiant de session (défaut: "default") — chaque uid a son quota de 20
<b>image_url</b>  URL http(s) ou data: d'une image à analyser (max ${Math.round(MAX_IMAGE_BYTES / 1048576)} Mo)
<b>images</b>      (POST) tableau de data URL / URL — max ${MAX_IMAGES}
<b>model</b>      lumo-max (défaut) | lumo
<b>reasoning</b>  fast (défaut) | think   — "think" active le raisonnement
<b>stream</b>     1 = flux SSE des tokens (GET)</pre>
<h2>Exemple de réponse</h2>
<pre>{"ok":true,"reply":"Bonjour ! Ça va bien, merci…","model":"lumo-max","uid":"123",
 "limits":{"lite":20,"max":19,"images":20},"rotations":0}</pre>`;

function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, err, status) {
  if (err instanceof LumoError) status = err.status || status;
  return sendJSON(res, status, { ok: false, error: { message: err.message || String(err), status } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

/**
 * Cœur du chat. params : { prompt, uid, model, reasoning, stream, imageSources:[] }
 * imageSources : liste brute (data URL / http URL). Préparées ici (SSRF…).
 */
async function handleChat(params, res) {
  const { prompt, uid, model, reasoning, stream } = params;
  const imageSources = params.imageSources || [];
  if (imageSources.length > MAX_IMAGES) {
    return sendError(res, new Error(`maximum ${MAX_IMAGES} images par requête`), 400);
  }
  const imageData = [];
  for (const src of imageSources) imageData.push(await prepareImage(src));

  if (!stream) {
    const out = await pool.chat({ uid, prompt, images: imageData.length ? imageData : null, model, reasoning });
    return sendJSON(res, 200, {
      ok: true,
      reply: out.content,
      ...(out.reasoning ? { reasoning: out.reasoning } : {}),
      model: model === 'lumo' || model === 'lumo-lite' ? 'lumo' : 'lumo-max',
      uid,
      limits: out.remaining,
      rotations: out.rotations,
      ...(imageData.length ? { vision: { attempts: out.visionAttempts, perceived: !out.blind } } : {}),
      ...(imageData.length && out.blind
        ? { warning: 'Lumo n’a pas perçu l’image (backend multimodal indisponible au moment de l’appel) — réessayez dans quelques secondes.' }
        : {}),
    });
  }

  // Mode flux SSE (GET uniquement) : tokens au fil de l'eau
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  });
  let full = '';
  try {
    const out = await pool.chat({
      uid, prompt, images: imageData.length ? imageData : null, model, reasoning,
      onChunk: ({ content, reasoning: r, retry }) => {
        if (content) { full += content; res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`); }
        else if (r) res.write(`data: ${JSON.stringify({ type: 'reasoning', content: r })}\n\n`);
        else if (retry) res.write(`data: ${JSON.stringify({ type: 'retry', attempt: retry })}\n\n`);
      },
    });
    res.write(`data: ${JSON.stringify({ type: 'done', reply: full, reasoning: out.reasoning, limits: out.remaining, rotations: out.rotations, ...(imageData.length ? { vision: { attempts: out.visionAttempts, perceived: !out.blind } } : {}) })}\n\n`);
    res.end();
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: { message: err.message, status: err.status || 500 } })}\n\n`);
      res.end();
    }
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.searchParams;

  // Préflight CORS (site externe → POST /api/chat)
  if (req.method === 'OPTIONS' && u.pathname.startsWith('/api/')) {
    return sendJSON(res, 204, {});
  }

  try {
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && u.pathname === '/health') {
      return sendJSON(res, 200, { ok: true, status: pool.status() });
    }
    if (req.method === 'GET' && u.pathname === '/api/limits') {
      const uid = (p.get('uid') || 'default').slice(0, 64);
      return sendJSON(res, 200, { ok: true, uid, limits: pool.limits(uid) });
    }
    if (u.pathname === '/api/chat' && (req.method === 'GET' || req.method === 'POST')) {
      let prompt = (p.get('prompt') || '').slice(0, MAX_PROMPT);
      let uid = (p.get('uid') || 'default').slice(0, 64);
      let model = (p.get('model') || DEFAULT_MODEL).toLowerCase();
      let reasoning = (p.get('reasoning') || 'fast') === 'think';
      const stream = req.method === 'GET' && (p.get('stream') === '1' || p.get('stream') === 'true');
      let imageUrl = p.get('image_url') || null;
      let images = null;

      if (req.method === 'POST') {
        let body = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* corps invalide → {} */ }
        if (body.prompt !== undefined) prompt = String(body.prompt).slice(0, MAX_PROMPT);
        if (body.uid !== undefined) uid = String(body.uid).slice(0, 64);
        if (body.model !== undefined) model = String(body.model).toLowerCase();
        if (body.reasoning !== undefined) reasoning = String(body.reasoning) === 'think' || body.reasoning === true;
        if (body.image_url !== undefined) imageUrl = body.image_url;
        if (Array.isArray(body.images) && body.images.length) images = body.images;
      }

      if (model !== 'lumo-max' && model !== 'lumo' && model !== 'lumo-lite') {
        return sendError(res, new Error("model doit être 'lumo-max' ou 'lumo'"), 400);
      }
      const imageSources = images && images.length ? images : imageUrl ? [imageUrl] : [];
      if (!prompt && imageSources.length === 0) {
        return sendError(res, new Error('paramètre "prompt" requis (ou image_url / images)'), 400);
      }
      return await handleChat({ prompt, uid, model, reasoning, stream, imageSources }, res);
    }
    return sendJSON(res, 404, { ok: false, error: { message: 'route inconnue', status: 404 } });
  } catch (err) {
    return sendError(res, err, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Lumo API prête : http://localhost:${PORT}`);
  console.log(`Exemple : curl "http://localhost:${PORT}/api/chat?prompt=bonjour&uid=1"`);
});
