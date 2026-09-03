// server.js — API REST anonyme pour Lumo (https://lumo.proton.me/guest)
//   GET /api/chat?prompt=...&uid=123
//   GET /api/chat?prompt=...&image_url=...&uid=123   (vision)
//   GET /api/limits?uid=123
//   GET /health
// Zéro dépendance — Node.js >= 18 (fetch + WebCrypto natifs).
import http from 'node:http';
import { URL } from 'node:url';
import { SessionPool, fetchImage, LumoError, DEFAULT_MODEL } from './lib/lumo.js';

const PORT = process.env.PORT || 3000;
const MAX_PROMPT = 20000; // caractères
const MAX_IMAGE_BYTES = parseInt(process.env.MAX_IMAGE_BYTES || String(10 * 1024 * 1024), 10);
const pool = new SessionPool();

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
<h2>Quota restant d'un uid</h2>
<pre>GET /api/limits?uid=123</pre>
<h2>Paramètres</h2>
<pre><b>prompt</b>     texte (requis sauf si image seule)
<b>uid</b>        identifiant de session (défaut: "default") — chaque uid a son quota de 20
<b>image_url</b>  URL http(s) ou data: d'une image à analyser (max ${Math.round(MAX_IMAGE_BYTES / 1048576)} Mo)
<b>model</b>      lumo-max (défaut) | lumo
<b>reasoning</b>  fast (défaut) | think   — "think" active le raisonnement
<b>stream</b>     1 = flux SSE des tokens</pre>
<h2>Exemple de réponse</h2>
<pre>{"ok":true,"reply":"Bonjour ! Ça va bien, merci…","model":"lumo-max","uid":"123",
 "limits":{"lite":20,"max":19,"images":20},"rotated":false}</pre>`;

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, err, status) {
  if (err instanceof LumoError) status = err.status || status;
  return sendJSON(res, status, { ok: false, error: { message: err.message || String(err), status } });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && u.pathname === '/health') {
      return sendJSON(res, 200, { ok: true, status: pool.status() });
    }
    if (req.method === 'GET' && u.pathname === '/api/limits') {
      const uid = (u.searchParams.get('uid') || 'default').slice(0, 64);
      return sendJSON(res, 200, { ok: true, uid, limits: pool.limits(uid) });
    }
    if (req.method === 'GET' && u.pathname === '/api/chat') {
      const p = u.searchParams;
      const prompt = (p.get('prompt') || '').slice(0, MAX_PROMPT);
      const uid = (p.get('uid') || 'default').slice(0, 64);
      const model = (p.get('model') || DEFAULT_MODEL).toLowerCase();
      if (model !== 'lumo-max' && model !== 'lumo' && model !== 'lumo-lite') {
        return sendError(res, new Error("model doit être 'lumo-max' ou 'lumo'"), 400);
      }
      const reasoning = (p.get('reasoning') || 'fast') === 'think';
      const stream = p.get('stream') === '1' || p.get('stream') === 'true';
      const imageUrl = p.get('image_url') || null;
      if (!prompt && !imageUrl) return sendError(res, new Error('paramètre "prompt" requis (ou image_url)'), 400);

      let imageData = null;
      if (imageUrl) imageData = await fetchImage(imageUrl, { maxBytes: MAX_IMAGE_BYTES });

      if (!stream) {
        const out = await pool.chat({ uid, prompt, imageData, model, reasoning });
        return sendJSON(res, 200, {
          ok: true,
          reply: out.content,
          ...(out.reasoning ? { reasoning: out.reasoning } : {}),
          model: model === 'lumo' || model === 'lumo-lite' ? 'lumo' : 'lumo-max',
          uid,
          limits: out.remaining,
          rotations: out.rotations,
          ...(imageData ? { vision: { attempts: out.visionAttempts, perceived: !out.blind } } : {}),
          ...(imageData && out.blind
            ? { warning: 'Lumo n’a pas perçu l’image (backend multimodal indisponible au moment de l’appel) — réessayez dans quelques secondes.' }
            : {}),
        });
      }

      // Mode flux : on renvoie les tokens au fil de l'eau (SSE)
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
          uid, prompt, imageData, model, reasoning,
          onChunk: ({ content, reasoning: r, retry }) => {
            if (content) { full += content; res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`); }
            else if (r) res.write(`data: ${JSON.stringify({ type: 'reasoning', content: r })}\n\n`);
            else if (retry) res.write(`data: ${JSON.stringify({ type: 'retry', attempt: retry })}\n\n`);
          },
        });
        res.write(`data: ${JSON.stringify({ type: 'done', reply: full, reasoning: out.reasoning, limits: out.remaining, rotations: out.rotations, ...(imageData ? { vision: { attempts: out.visionAttempts, perceived: !out.blind } } : {}) })}\n\n`);
        res.end();
      } catch (err) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: { message: err.message, status: err.status || 500 } })}\n\n`);
          res.end();
        }
      }
      return;
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
