// test.js — valide l'API locale : santé, limites, chat texte, vision, stream, erreurs.
// Usage : node server.js (dans un autre terminal) puis node test.js
const BASE = process.env.BASE || 'http://localhost:3000';

async function call(path) {
  const r = await fetch(BASE + path);
  let body;
  try { body = await r.json(); } catch { body = await r.text(); }
  return { status: r.status, body };
}

function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

const uid = 'test' + Date.now();

const health = await call('/health');
check('health ok', health.status === 200 && health.body.ok === true);

const limits0 = await call(`/api/limits?uid=${uid}`);
check('limits init 20/20/20', limits0.body.limits?.lite === 20 && limits0.body.limits?.max === 20 && limits0.body.limits?.images === 20, JSON.stringify(limits0.body));

// --- chat texte ---
const t0 = Date.now();
const chat = await call(`/api/chat?prompt=${encodeURIComponent('Bonjour, comment ça va ? Réponds en une phrase.')}&uid=${uid}`);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
check('chat texte HTTP 200', chat.status === 200, `(${dt}s)`);
check('chat texte reply non vide', typeof chat.body.reply === 'string' && chat.body.reply.length > 0, chat.body.reply?.slice(0, 120));
check('chat texte limits max décrémenté', chat.body.limits?.max === 19, JSON.stringify(chat.body.limits));

// --- chat avec modèle lite ---
const lite = await call(`/api/chat?prompt=${encodeURIComponent('Dis bonjour.')}&uid=${uid}&model=lumo`);
check('chat lite HTTP 200', lite.status === 200 && lite.body.limits?.lite === 19, JSON.stringify(lite.body.limits));

// --- mode reasoning "think" (prompt non trivial pour garantir du reasoning) ---
const think = await call(`/api/chat?prompt=${encodeURIComponent('Résous 17*23 en détaillant le calcul.')}&uid=${uid}&reasoning=think`);
check('chat think HTTP 200', think.status === 200, JSON.stringify(think.body).slice(0, 120));

// --- mode stream ---
const sr = await fetch(`${BASE}/api/chat?prompt=${encodeURIComponent('Compte de 1 à 3.')}&uid=${uid}&stream=1`);
const sseText = await sr.text();
check('stream HTTP 200', sr.status === 200);
const sseParts = sseText.split('\n\n').filter((x) => x.startsWith('data:'));
check('stream a des chunks', sseParts.some((x) => x.includes('"type":"chunk"')));
check('stream se termine par done', sseParts.some((x) => x.includes('"type":"done"')), sseParts[sseParts.length - 1]?.slice(0, 100));

// --- erreurs ---
const noPrompt = await call('/api/chat?uid=abc');
check('prompt manquant -> 400', noPrompt.status === 400);
const badModel = await call(`/api/chat?prompt=hi&model=turbo`);
check('mauvais model -> 400', badModel.status === 400);
const badImg = await call(`/api/chat?image_url=${encodeURIComponent('https://nonexistent.invalid/x.png')}&prompt=decris`);
check('image invalide -> 400/502', [400, 502].includes(badImg.status), String(badImg.status));

console.log('\nTerminé.');
