import express from 'express';
import { syncMessages, refreshCredentials } from './easychat.js';

const app = express();
app.disable('x-powered-by');

function authorized(req) {
  const expected = process.env.SYNC_KEY?.trim();
  if (!expected) return false;
  const supplied = req.get('x-sync-key')?.trim();
  return supplied === expected;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'fortis-easychat-sync', time: new Date().toISOString() });
});

app.get('/auth-check', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    await refreshCredentials();
    res.json({ ok: true, easychat_credentials: 'captured' });
  } catch (error) {
    res.status(503).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get('/sync', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const sinceRaw = req.query.since;
  let sinceSec = 0;
  if (sinceRaw) {
    if (/^\d+$/.test(String(sinceRaw))) sinceSec = Number(sinceRaw);
    else {
      const ms = Date.parse(String(sinceRaw));
      if (Number.isFinite(ms)) sinceSec = Math.floor(ms / 1000);
    }
  }
  const overlapSec = Math.max(0, Math.min(3600, Number(req.query.overlap_seconds || 120)));

  try {
    const result = await syncMessages({ sinceSec, overlapSec });
    res.json(result);
  } catch (error) {
    console.error('SYNC ERROR', error);
    res.status(503).json({ ok: false, error: String(error?.message || error) });
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Fortis EasyChat sync listening on :${port}`);
});
