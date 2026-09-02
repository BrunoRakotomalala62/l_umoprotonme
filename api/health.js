/** Fonction serverless Vercel : GET /api/health */
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
  return json(res, 200, { status: 'ok', uptime_s: Math.round(process.uptime()) });
}
