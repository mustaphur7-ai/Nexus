import fs from 'node:fs/promises';
import path from 'node:path';

const CBOE_OPTIONS_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options/GLD.json';
const OUT_PATH = path.resolve('data/analysis.json');
const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCboeOptions() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(CBOE_OPTIONS_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GoldOptionsTerminal/1.0)',
          'Accept': 'application/json, text/plain, */*'
        }
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const json = await res.json();
      const payload = json?.data ?? json;
      if (!payload || !Array.isArray(payload.options) || payload.options.length === 0) {
        throw new Error('CBOE options array missing or empty');
      }
      return payload;
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastErr;
}

function parseOptionSymbol(opt) {
  // CBOE option symbol format typically ends with YYMMDD[C|P]00STRIKE (e.g. GLD261218C00250000)
  const sym = String(opt.option || opt.symbol || '');
  const match = sym.match(/(\d{6})([CP])(\d{8})$/);
  const strike = Number(opt.strike ?? opt.strike_price ?? (match ? Number(match[3]) / 1000 : NaN));
  const side = (opt.option_type || opt.type || match?.[2] || '').toUpperCase();
  const isCall = side === 'C' || side === 'CALL';
  const isPut = side === 'P' || side === 'PUT';
  const gamma = Number(opt.gamma ?? 0);
  const openInterest = Number(opt.open_interest ?? opt.oi ?? 0);
  const iv = Number(opt.iv ?? opt.implied_volatility ?? 0);
  const exp = match ? `20${match[1].slice(0, 2)}-${match[1].slice(2, 4)}-${match[1].slice(4, 6)}` : (opt.expiration || null);
  return { strike, isCall, isPut, gamma, openInterest, iv, exp };
}

function buildAnalysis(payload) {
  const rawSpot = Number(
    payload.current_price ??
    payload.last_trade_price ??
    payload.close ??
    payload.prev_close
  );
  if (!Number.isFinite(rawSpot) || rawSpot <= 0) {
    throw new Error('Could not determine valid spot price from CBOE options payload');
  }

  const prevClose = Number(payload.prev_close ?? rawSpot);
  const change = Number((rawSpot - prevClose).toFixed(2));
  const changePct = prevClose ? Number(((change / prevClose) * 100).toFixed(2)) : 0;

  const byStrike = new Map();
  let atmCandidate = null;
  let minStrikeDiff = Infinity;

  for (const rawOpt of payload.options) {
    const { strike, isCall, isPut, gamma, openInterest, iv, exp } = parseOptionSymbol(rawOpt);
    if (!Number.isFinite(strike) || strike <= 0) continue;

    // Keep strikes within +/- 15% of the options payload's own spot price
    if (Math.abs(strike - rawSpot) / rawSpot > 0.15) continue;

    const diff = Math.abs(strike - rawSpot);
    if (diff < minStrikeDiff && iv > 0) {
      minStrikeDiff = diff;
      atmCandidate = { iv, exp };
    }

    if (!byStrike.has(strike)) {
      byStrike.set(strike, {
        strike,
        call_gex: 0,
        put_gex: 0,
        net_gex: 0,
        call_oi: 0,
        put_oi: 0
      });
    }

    const bucket = byStrike.get(strike);
    // Standard dealer GEX scaling per contract (100 multiplier) * spot^2 * 0.01
    const contractScale = gamma * openInterest * 100 * rawSpot * rawSpot * 0.01;

    if (isCall) {
      bucket.call_gex += contractScale;
      bucket.call_oi += openInterest;
    } else if (isPut) {
      bucket.put_gex -= contractScale;
      bucket.put_oi += openInterest;
    }
    bucket.net_gex = Number((bucket.call_gex + bucket.put_gex).toFixed(0));
  }

  const strikes = Array.from(byStrike.values())
    .map((b) => ({
      strike: b.strike,
      call_gex: Number(b.call_gex.toFixed(0)),
      put_gex: Number(b.put_gex.toFixed(0)),
      net_gex: b.net_gex,
      call_oi: b.call_oi,
      put_oi: b.put_oi
    }))
    .sort((a, b) => a.strike - b.strike);

  const totalNetGex = strikes.reduce((acc, s) => acc + s.net_gex, 0);

  // Top call-wall strikes above spot, top put-wall strikes below spot
  const resistances = strikes
    .filter((s) => s.strike >= rawSpot && s.call_gex > 0)
    .sort((a, b) => b.call_gex - a.call_gex)
    .slice(0, 3)
    .sort((a, b) => a.strike - b.strike)
    .map((s, idx) => ({
      label: `R${idx + 1}`,
      price: s.strike,
      type: 'Call wall',
      gex: s.call_gex
    }));

  const supports = strikes
    .filter((s) => s.strike <= rawSpot && Math.abs(s.put_gex) > 0)
    .sort((a, b) => Math.abs(b.put_gex) - Math.abs(a.put_gex))
    .slice(0, 3)
    .sort((a, b) => b.strike - a.strike)
    .map((s, idx) => ({
      label: `S${idx + 1}`,
      price: s.strike,
      type: 'Put wall',
      gex: s.put_gex
    }));

  // Approximate gamma flip as strike where cumulative net GEX changes sign near spot
  let cumGex = 0;
  let gammaFlip = null;
  let prev = null;
  for (const s of strikes) {
    cumGex += s.net_gex;
    if (prev !== null && ((prev.cum < 0 && cumGex >= 0) || (prev.cum > 0 && cumGex <= 0))) {
      gammaFlip = s.strike;
      break;
    }
    prev = { strike: s.strike, cum: cumGex };
  }

  const atmIv = atmCandidate?.iv ? Number(atmCandidate.iv.toFixed(4)) : 0.2;
  const dailySigma = Number((rawSpot * atmIv * Math.sqrt(1 / 252)).toFixed(2));
  const weeklySigma = Number((rawSpot * atmIv * Math.sqrt(5 / 252)).toFixed(2));

  return {
    generated_at: new Date().toISOString(),
    source: 'cboe-delayed-options-GLD',
    nearest_expiry: atmCandidate?.exp ?? null,
    spot: Number(rawSpot.toFixed(2)),
    prev_close: Number(prevClose.toFixed(2)),
    change,
    change_pct: changePct,
    atm_iv: atmIv,
    resistances,
    supports,
    gamma_flip: gammaFlip,
    expected_range: {
      daily_1sd: [Number((rawSpot - dailySigma).toFixed(2)), Number((rawSpot + dailySigma).toFixed(2))],
      daily_2sd: [Number((rawSpot - 2 * dailySigma).toFixed(2)), Number((rawSpot + 2 * dailySigma).toFixed(2))],
      weekly_1sd: [Number((rawSpot - weeklySigma).toFixed(2)), Number((rawSpot + weeklySigma).toFixed(2))],
      weekly_2sd: [Number((rawSpot - 2 * weeklySigma).toFixed(2)), Number((rawSpot + 2 * weeklySigma).toFixed(2))]
    },
    gex_by_strike: strikes,
    bias: totalNetGex >= 0 ? 'POSITIVE GAMMA' : 'NEGATIVE GAMMA'
  };
}

async function main() {
  const payload = await fetchCboeOptions();
  const analysis = buildAnalysis(payload);
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(analysis, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUT_PATH} | spot=${analysis.spot} | strikes=${analysis.gex_by_strike.length}`);
}

main().catch((err) => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
