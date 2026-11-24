import fs from 'node:fs/promises';
import path from 'node:path';

const ANALYSIS_PATH = path.resolve('data/analysis.json');
const STATE_PATH = path.resolve('data/alert-state.json');
const PROXIMITY_THRESHOLD = 0.0025; // 0.25%
const COOLDOWN_MS = 30 * 60 * 1000;

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function main() {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log('NTFY_TOPIC not set; skipping push.');
    return;
  }

  const analysis = await readJson(ANALYSIS_PATH, null);
  if (!analysis || typeof analysis.spot !== 'number') {
    console.log('No valid spot in data/analysis.json; skipping alert check.');
    return;
  }

  const spot = analysis.spot;
  const levels = [
    ...(analysis.resistances || []),
    ...(analysis.supports || []),
    ...(typeof analysis.gamma_flip === 'number'
      ? [{ label: 'FLIP', price: analysis.gamma_flip, type: 'Gamma flip' }]
      : [])
  ];

  const state = await readJson(STATE_PATH, { last_sent: {} });
  state.last_sent = state.last_sent || {};
  const now = Date.now();
  let updated = false;

  for (const lvl of levels) {
    if (typeof lvl.price !== 'number' || lvl.price <= 0) continue;
    const distPct = Math.abs(spot - lvl.price) / lvl.price;
    if (distPct <= PROXIMITY_THRESHOLD) {
      const key = `${lvl.label}_${lvl.price}`;
      const prevTime = state.last_sent[key] || 0;
      if (now - prevTime >= COOLDOWN_MS) {
        const message = `${analysis.source} | Spot ${spot.toFixed(2)} near ${lvl.label} (${lvl.type}) @ ${lvl.price.toFixed(2)} (${(distPct * 100).toFixed(2)}%)`;
        const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
          method: 'POST',
          headers: {
            'Title': `Options Level Alert: ${lvl.label}`,
            'Priority': 'default'
          },
          body: message
        });
        if (res.ok) {
          state.last_sent[key] = now;
          updated = true;
          console.log('Sent alert:', message);
        }
      }
    }
  }

  if (updated) {
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }
}

main().catch((err) => {
  console.error('Alert check error:', err);
  process.exit(1);
});
