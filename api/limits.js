/**
 * Fonction serverless Vercel : GET /api/limits?uid=123
 * En mode serverless chaque requête ouvre une session anonyme neuve (quota
 * complet 20/20/20) : ce endpoint renvoie donc toujours le quota initial.
 */
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
  const uid = (parsed.searchParams.get('uid') || 'default').slice(0, 64);
  return json(res, 200, {
    ok: true,
    uid,
    limits: { lite: 20, max: 20, images: 20, rotations: 0 },
    note: 'serverless : quota d’une session neuve (chaque requête = session anonyme distincte)',
  });
}
