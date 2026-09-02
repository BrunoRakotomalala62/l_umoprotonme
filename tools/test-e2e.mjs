// E2E test: POST chat/completions to lumo.proton.me with full U2L encryption
// Node >= 18 (global fetch, WebCrypto), requires openpgp v6 in node_modules
import * as openpgp from 'openpgp';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const HOST = 'https://lumo.proton.me';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.124 Safari/537.36';

const enc = (bytes) => Buffer.from(bytes).toString('base64');
const b64u8 = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

async function aesEncrypt(keyBytes, plaintextBytes, ad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, plaintextBytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12);
  return enc(out);
}
async function aesDecrypt(keyBytes, b64payload, ad) {
  const buf = b64u8(b64payload);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12), additionalData: ad }, key, buf.slice(12));
  return new TextDecoder().decode(pt);
}

async function wrapRequestKey(binaryPubkey, keyBytes) {
  const pub = await openpgp.readKey({ binaryKey: binaryPubkey });
  const msg = await openpgp.createMessage({ binary: new Uint8Array(keyBytes) });
  const encrypted = await openpgp.encrypt({ message: msg, encryptionKeys: pub, format: 'binary' });
  return Buffer.from(encrypted).toString('base64');
}

async function main() {
  const prompt = process.argv[2] || 'bonjour, comment ça va ? Réponds en une phrase.';
  const model = process.argv[3] || 'lumo-max';
  const pubkey = readFileSync(new URL('./lumo-pubkey.bin', import.meta.url));

  const requestKey = crypto.getRandomValues(new Uint8Array(32));
  const requestId = crypto.randomUUID();
  console.error('requestId:', requestId);

  const userMsg = await aesEncrypt(requestKey, new TextEncoder().encode(prompt), new TextEncoder().encode(`lumo.request.${requestId}.turn`));
  const request_key = await wrapRequestKey(pubkey, requestKey);
  console.error('request_key bytes:', Buffer.from(request_key, 'base64').length);

  const body = {
    model,
    messages: [{ role: 'user', content: userMsg, encrypted: true }],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'none',
    lumo: { client_type: 'frontend', request_key, request_id: requestId },
  };

  const r = await fetch(`${HOST}/api/ai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      accept: 'application/vnd.protonmail.v1+json',
      'content-type': 'application/json',
      'x-pm-appversion': 'web-lumo@2.0.2.0',
      'x-pm-locale': 'en_US',
      origin: 'https://lumo.proton.me',
      referer: 'https://lumo.proton.me/guest/',
    },
    body: JSON.stringify(body),
  });
  console.error('HTTP', r.status, r.headers.get('content-type'));
  const text = await r.text();
  console.error('BODY len', text.length);
  if (!r.ok) { console.log(text.slice(0, 2000)); process.exit(1); }

  // parse SSE
  let answer = '';
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { console.log('RAW:', payload.slice(0, 200)); continue; }
    const choice = ev.choices && ev.choices[0];
    const delta = choice && choice.delta;
    if (delta && delta.content && delta.encrypted !== false) {
      try {
        const pt = await aesDecrypt(requestKey, delta.content, new TextEncoder().encode(`lumo.response.${requestId}.chunk`));
        answer += pt;
        process.stdout.write(pt);
      } catch (e) { console.error('\nDECRYPT FAIL', String(e), JSON.stringify(delta).slice(0, 120)); }
    } else if (delta && delta.content) {
      answer += delta.content; process.stdout.write(delta.content);
    } else if (ev.usage) {
      console.error('\nUSAGE', JSON.stringify(ev.usage));
    }
  }
  console.error('\nFULL ANSWER:', JSON.stringify(answer));
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
