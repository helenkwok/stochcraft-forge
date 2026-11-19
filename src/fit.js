// Which distribution describes the measured work times best? Maximum-likelihood fits of four families and their AIC
// (lower is better; 2 per parameter minus twice the log-likelihood). Times are positive numbers (days).

const lnGamma = (z) => {
  // Lanczos approximation (g = 7)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};
const digamma = (x) => { let r = 0; while (x < 6) { r -= 1 / x; x += 1; } const f = 1 / (x * x); return r + Math.log(x) - 0.5 / x - f * (1 / 12 - f * (1 / 120 - f / 252)); };
const trigamma = (x) => { let r = 0; while (x < 6) { r += 1 / (x * x); x += 1; } const f = 1 / (x * x); return r + 1 / x + f / 2 + (f / x) * (1 / 6 - f * (1 / 30 - f / 42)); };

export function fitFamilies(sample) {
  const x = sample.filter((v) => Number.isFinite(v) && v > 0);
  const n = x.length;
  if (n < 20) return null;
  const sum = x.reduce((a, b) => a + b, 0), mean = sum / n;
  const lx = x.map(Math.log), slx = lx.reduce((a, b) => a + b, 0), mlx = slx / n;
  const out = [];
  // exponential
  out.push({ family: 'exponential', k: 1, ll: n * Math.log(1 / mean) - sum / mean, params: { mean } });
  // log-normal
  const s2 = lx.reduce((a, b) => a + (b - mlx) ** 2, 0) / n, sg = Math.sqrt(s2);
  out.push({ family: 'log-normal', k: 2, ll: -slx - n * Math.log(sg) - (n / 2) * Math.log(2 * Math.PI) - n / 2, params: { mu: mlx, sigma: sg } });
  // gamma: solve ln k - digamma(k) = ln(mean) - mean(ln x)
  const s = Math.log(mean) - mlx;
  if (s > 0) {
    let k = (3 - s + Math.sqrt((s - 3) ** 2 + 24 * s)) / (12 * s);
    for (let i = 0; i < 20; i++) k -= (Math.log(k) - digamma(k) - s) / (1 / k - trigamma(k));
    if (k > 0 && Number.isFinite(k)) { const th = mean / k; out.push({ family: 'gamma', k: 2, ll: (k - 1) * slx - sum / th - n * k * Math.log(th) - n * lnGamma(k), params: { shape: k, mean } }); }
  }
  // Weibull: Newton on the shape
  let k = 1.2;
  for (let i = 0; i < 60; i++) {
    let a = 0, b = 0, c = 0;
    for (let j = 0; j < n; j++) { const p = x[j] ** k; a += p; b += p * lx[j]; c += p * lx[j] * lx[j]; }
    const g = b / a - 1 / k - mlx, dg = (c * a - b * b) / (a * a) + 1 / (k * k);
    const nk = k - g / dg;
    if (!(nk > 0) || !Number.isFinite(nk)) break;
    if (Math.abs(nk - k) < 1e-10) { k = nk; break; }
    k = nk;
  }
  if (k > 0 && Number.isFinite(k)) {
    const lam = (x.reduce((a, v) => a + v ** k, 0) / n) ** (1 / k);
    out.push({ family: 'weibull', k: 2, ll: n * Math.log(k) - n * k * Math.log(lam) + (k - 1) * slx - x.reduce((a, v) => a + (v / lam) ** k, 0), params: { shape: k, scale: lam } });
  }
  for (const o of out) o.aic = 2 * o.k - 2 * o.ll;
  out.sort((p, q) => p.aic - q.aic);
  const best = out[0].aic;
  for (const o of out) o.deltaAic = o.aic - best;
  const sorted = x.slice().sort((a, b) => a - b);
  return { n, ranking: out.map(({ family, aic, deltaAic, params }) => ({ family, aic, deltaAic, params })), best: out[0].family, observedP85: sorted[Math.min(n - 1, Math.floor(0.85 * n))], lognormalP85: Math.exp(mlx + 1.0364 * sg) };
}
