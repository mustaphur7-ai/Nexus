async function loadAnalysis() {
  const res = await fetch(`./data/analysis.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load analysis.json (${res.status})`);
  return res.json();
}

function fmt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '--';
}

function render(data) {
  const spotEl = document.getElementById('spot-price');
  const chgEl = document.getElementById('spot-change');
  const metaEl = document.getElementById('meta');
  const levelsEl = document.getElementById('levels-list');
  const regimeEl = document.getElementById('regime-box');
  const gexEl = document.getElementById('gex-list');

  if (!data || typeof data.spot !== 'number') {
    spotEl.textContent = '--';
    metaEl.textContent = 'No live options snapshot yet. Run the GitHub Actions workflow to populate data/analysis.json.';
    return;
  }

  spotEl.textContent = fmt(data.spot);
  const sign = (data.change ?? 0) >= 0 ? '+' : '';
  chgEl.textContent = `${sign}${fmt(data.change)} (${sign}${data.change_pct ?? 0}%)`;
  chgEl.className = (data.change ?? 0) >= 0 ? 'pos' : 'neg';

  metaEl.textContent = `Source: ${data.source || 'options'} | Exp: ${data.nearest_expiry || '--'} | Updated: ${data.generated_at || '--'}`;

  const allLevels = [
    ...(data.resistances || []).map((r) => ({ k: `${r.label} (${r.type})`, v: fmt(r.price) })),
    { k: 'Gamma Flip', v: fmt(data.gamma_flip) },
    ...(data.supports || []).map((s) => ({ k: `${s.label} (${s.type})`, v: fmt(s.price) }))
  ];

  levelsEl.innerHTML = allLevels
    .map((item) => `<div class="pill"><div class="k">${item.k}</div><div class="v">${item.v}</div></div>`)
    .join('');

  const r = data.expected_range || {};
  const regimeItems = [
    { k: 'Regime Bias', v: data.bias || '--' },
    { k: 'ATM IV', v: data.atm_iv ? `${(data.atm_iv * 100).toFixed(1)}%` : '--' },
    { k: 'Daily 1σ', v: Array.isArray(r.daily_1sd) ? `${fmt(r.daily_1sd[0])} – ${fmt(r.daily_1sd[1])}` : '--' },
    { k: 'Weekly 1σ', v: Array.isArray(r.weekly_1sd) ? `${fmt(r.weekly_1sd[0])} – ${fmt(r.weekly_1sd[1])}` : '--' }
  ];

  regimeEl.innerHTML = regimeItems
    .map((item) => `<div class="pill"><div class="k">${item.k}</div><div class="v">${item.v}</div></div>`)
    .join('');

  const strikes = (data.gex_by_strike || [])
    .filter((s) => Math.abs(s.strike - data.spot) / data.spot <= 0.06);

  const maxAbs = Math.max(1, ...strikes.map((s) => Math.abs(s.net_gex || 0)));

  gexEl.innerHTML = strikes
    .map((s) => {
      const val = s.net_gex || 0;
      const pct = Math.min(100, Math.round((Math.abs(val) / maxAbs) * 100));
      const cls = val >= 0 ? 'pos' : 'neg';
      const bg = val >= 0 ? 'var(--pos)' : 'var(--neg)';
      return `
        <div class="gex-row">
          <span>${fmt(s.strike)}</span>
          <div class="bar-wrap"><div class="bar-fill" style="width:${pct}%;background:${bg};"></div></div>
          <span class="${cls}" style="text-align:right;">${val.toLocaleString()}</span>
        </div>
      `;
    })
    .join('');
}

loadAnalysis()
  .then(render)
  .catch((err) => {
    document.getElementById('meta').textContent = err.message;
  });
