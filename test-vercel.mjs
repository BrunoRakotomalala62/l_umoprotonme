/**
 * Harness de test local pour les fonctions Vercel (api/chat.js, api/limits.js).
 * Simule l'objet (req, res) d'une fonction Node Vercel.
 *
 *   node test-vercel.mjs                    -> validation + 1 vrai chat texte
 *   SKIP_CHAT=1 node test-vercel.mjs        -> validation seulement
 *   IMAGE_URL=... node test-vercel.mjs      -> ajoute un test vision (budget 50 s)
 */
const SKIP_CHAT = !!process.env.SKIP_CHAT;
const IMAGE_URL = process.env.IMAGE_URL || null;

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(o) { this.body = o; return this; },
  };
}

async function callHandler(mod, query, { method = 'GET', body = null } = {}) {
  const { default: handler } = await import(mod);
  const qs = new URLSearchParams(query).toString();
  const res = makeRes();
  const req = { method, url: `/api/x?${qs}` };
  if (method === 'POST') {
    const payload = typeof body === 'string' ? body : JSON.stringify(body || {});
    req.body = payload; // IncomingMessage async-iterable simulé
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(payload); };
  }
  await handler(req, res);
  return { statusCode: res.statusCode, body: res.body };
}

const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
};

async function main() {
  // --- validation ---
  let r = await callHandler('./api/chat.js', { uid: 'v' });
  check('sans prompt -> 400', r.statusCode === 400, JSON.stringify(r.body));

  r = await callHandler('./api/chat.js', { prompt: 'hi', model: 'turbo' });
  check('mauvais model -> 400', r.statusCode === 400);

  r = await callHandler('./api/chat.js', { prompt: 'hi', image_url: 'http://127.0.0.1:8899/x.png' });
  check('image IP privée bloquée -> 400', r.statusCode === 400, JSON.stringify(r.body?.error?.message));

  r = await callHandler('./api/chat.js', { prompt: 'hi', image_url: 'ftp://x/y' });
  check('image protocole interdit -> 400', r.statusCode === 400);

  r = await callHandler('./api/limits.js', { uid: 'v' });
  check('limits -> 200 20/20/20', r.statusCode === 200 && r.body.limits?.max === 20);

  // --- POST JSON ---
  r = await callHandler('./api/chat.js', {}, { method: 'POST', body: {} });
  check('POST sans prompt -> 400', r.statusCode === 400, JSON.stringify(r.body?.error?.message));

  r = await callHandler('./api/chat.js', {}, { method: 'POST', body: { prompt: 'hi', images: ['http://127.0.0.1:8899/x.png'] } });
  check('POST image IP privée bloquée -> 400', r.statusCode === 400, JSON.stringify(r.body?.error?.message));

  r = await callHandler('./api/chat.js', {}, { method: 'POST', body: { prompt: 'hi', images: ['ftp://x/y'] } });
  check('POST image protocole interdit -> 400', r.statusCode === 400);

  r = await callHandler('./api/chat.js', {}, { method: 'POST', body: { prompt: 'hi', images: ['data:image/png;base64,iVBORw0KGgo='] } });
  check('POST data:image acceptée', r.statusCode === 200 || r.statusCode === 502, String(r.statusCode) + ' ' + JSON.stringify(r.body?.error || r.body?.vision || '').slice(0, 120));

  if (SKIP_CHAT) { console.log('SKIP_CHAT=1 : pas d’appel réel.'); return; }

  // --- vrai chat texte (budget global ~55 s) ---
  const t0 = Date.now();
  r = await callHandler('./api/chat.js', { prompt: 'Bonjour, une phrase.', uid: 'vercel-test' });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  check('chat texte -> 200 + reply', r.statusCode === 200 && r.body?.ok === true && (r.body?.reply || '').length > 0, `(${dt}s) ${r.body?.reply?.slice(0, 80)}`);

  if (IMAGE_URL) {
    const t1 = Date.now();
    r = await callHandler('./api/chat.js', {
      prompt: 'Décris cette image en une phrase.',
      image_url: IMAGE_URL,
      uid: 'vercel-vision',
    });
    const dt2 = ((Date.now() - t1) / 1000).toFixed(1);
    check('vision -> 200', r.statusCode === 200, `(${dt2}s) vision=${JSON.stringify(r.body?.vision)}`);
    if (r.statusCode === 200) console.log('  reply:', (r.body.reply || '').slice(0, 200));
  }

  console.log('\nTerminé.');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
