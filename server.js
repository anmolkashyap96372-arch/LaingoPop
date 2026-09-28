// LaingoPop push server: stores subscriptions and sends web-push at the user's reminder times
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT = 'mailto:you@example.com' } = process.env;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars. Run: npm run keys');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'subs.json');
let subs = {}; // endpoint -> record
try { subs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
const persist = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(subs)); } catch (e) { console.error('persist', e.message); } };

const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));

app.get('/', (_, res) => res.send('LaingoPop push server OK'));
app.get('/health', (_, res) => res.json({ ok: true, subs: Object.keys(subs).length }));

const router = express.Router();
router.get('/config', (_, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

router.post('/subscribe', (req, res) => {
  const b = req.body || {};
  if (!b.sub || !b.sub.endpoint) return res.status(400).json({ ok: false });
  const old = subs[b.sub.endpoint] || {};
  subs[b.sub.endpoint] = {
    sub: b.sub, tz: b.tz || 'UTC', mode: b.mode, times: Array.isArray(b.times) ? b.times : [],
    interval: Number(b.interval) || 0, intervalAnchor: Number(b.intervalAnchor) || 0,
    accountId: b.accountId, fired: old.fired || {}, lastInterval: old.lastInterval || 0,
  };
  persist();
  res.json({ ok: true });
});

router.post('/unsubscribe', (req, res) => {
  const ep = req.body && req.body.endpoint;
  if (ep && subs[ep]) { delete subs[ep]; persist(); }
  res.json({ ok: true });
});

router.post('/test', async (req, res) => {
  const rec = subs[req.body && req.body.endpoint];
  if (!rec) return res.status(404).json({ ok: false });
  try { await send(rec, { title: 'LaingoPop test', body: 'Push is working. Tap to open your quiz.' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});
app.use('/api/push', router);

async function send(rec, payload) {
  try {
    await webpush.sendNotification(rec.sub, JSON.stringify({ ...payload, tag: 'laingopop-reminder', url: './?action=quiz&alarm=1' }), { TTL: 3600, urgency: 'high' });
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { delete subs[rec.sub.endpoint]; persist(); }
    throw e;
  }
}

function localParts(tz, d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

async function tick() {
  const now = Date.now();
  for (const rec of Object.values(subs)) {
    try {
      let tz = rec.tz; try { localParts(tz); } catch { tz = 'UTC'; }
      const { day, hm } = localParts(tz);
      // fixed-time reminders (fires within the minute; dedupe per day)
      for (const t of rec.times) {
        const key = day + '@' + t;
        if (t === hm && !rec.fired[key]) {
          rec.fired[key] = 1;
          await send(rec, { title: 'LaingoPop', body: 'A few words are waiting. Tap to answer.' });
        }
      }
      for (const k of Object.keys(rec.fired)) if (!k.startsWith(day)) delete rec.fired[k];
      // repeating interval reminders (minutes)
      if (rec.interval > 0) {
        const base = Math.max(rec.intervalAnchor, rec.lastInterval);
        if (base && now - base >= rec.interval * 60000) {
          rec.lastInterval = now;
          await send(rec, { title: 'LaingoPop', body: 'Quick revision time. Tap to answer.' });
        }
      }
    } catch (e) { /* one bad sub must not stop others */ }
  }
  persist();
}
setInterval(tick, 30 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('LaingoPop push server on', PORT));
