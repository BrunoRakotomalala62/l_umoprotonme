// E2E vision test: send an image (encrypted) to chat/completions and decrypt the description
import * as openpgp from 'openpgp';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const HOST = 'https://lumo.proton.me';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.124 Safari/537.36';
const enc = (bytes) => Buffer.from(bytes).toString('base64');

async function aesEncrypt(keyBytes, plaintextBytes, ad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, plaintextBytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12);
  return enc(out);
}
async function aesDecrypt(keyBytes, b64payload, ad) {
  const buf = new Uint8Array(Buffer.from(b64payload, 'base64'));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12), additionalData: ad }, key, buf.slice(12));
  return new TextDecoder().decode(pt);
}

const main = async () => {
  const pubkey = readFileSync(new URL('./lumo-pubkey.bin', import.meta.url));
  const image = readFileSync(new URL('./test-image.png', import.meta.url));
  const prompt = process.argv[2] || 'Décris précisément cette image (couleurs, composition).';

  const requestKey = crypto.getRandomValues(new Uint8Array(32));
  const requestId = crypto.randomUUID();
  const adReq = new TextEncoder().encode(`lumo.request.${requestId}.turn`);
  const pub = await openpgp.readKey({ binaryKey: pubkey });

  const textEnc = await aesEncrypt(requestKey, new TextEncoder().encode(prompt), adReq);
  const imgEnc = await aesEncrypt(requestKey, new Uint8Array(image), adReq);

  const parts = [
    { type: 'text', text: textEnc, encrypted: true },
    { type: 'image_url', image_url: { url: `data:application/octet-stream;base64,${imgEnc}`, encrypted: true } },
  ];
  const request_key = Buffer.from(await openpgp.encrypt({ message: await openpgp.createMessage({ binary: new Uint8Array(requestKey) }), encryptionKeys: pub, format: 'binary' })).toString('base64');

  const body = {
    model: 'lumo-max',
    messages: [{ role: 'user', content: parts, encrypted: true }],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'none',
    lumo: { client_type: 'frontend', request_key, request_id: requestId },
  };
  const r = await fetch(`${HOST}/api/ai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'user-agent': UA, accept: 'application/vnd.protonmail.v1+json', 'content-type': 'application/json',
      'x-pm-appversion': 'web-lumo@2.0.2.0', 'x-pm-locale': 'en_US', origin: 'https://lumo.proton.me', referer: 'https://lumo.proton.me/guest/' },
    body: JSON.stringify(body),
  });
  console.error('HTTP', r.status, r.headers.get('content-type'));
  const text = await r.text();
  if (!r.ok) { console.log(text.slice(0, 2000)); process.exit(1); }
  let answer = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev; try { ev = JSON.parse(payload); } catch { continue; }
    const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (delta && delta.content) {
      if (delta.encrypted === false) { answer += delta.content; }
      else {
        try { const pt = await aesDecrypt(requestKey, delta.content, new TextEncoder().encode(`lumo.response.${requestId}.chunk`)); answer += pt; }
        catch (e) { console.error('decrypt err', String(e)); }
      }
    } else if (ev.usage) console.error('\nUSAGE', JSON.stringify(ev.usage));
  }
  console.log('\nANSWER:', answer);
};
main().catch((e) => { console.error('ERR', e); process.exit(1); });
