// The forecast as a Jira comment (Atlassian Document Format). The panel sends the two answers it holds; only the
// numeric fields used here are read, each checked, so nothing else the client sends reaches the comment.

const fin = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
const num = (x, n = 2) => (fin(x) == null ? 'n/a' : fin(x).toFixed(n));
const hours = (d) => num(fin(d) == null ? null : d * 24, 1) + ' h';
const mins = (d) => num(fin(d) == null ? null : d * 1440, 1) + ' min';
const pct = (x) => (fin(x) == null ? 'n/a' : num(x * 100, 0) + '%');
const clean = (s, max = 80) => String(s ?? '').replace(/[^\p{L}\p{N} .,:/_x×-]/gu, '').slice(0, max);

const text = (t, marks) => ({ type: 'text', text: String(t) || ' ', ...(marks ? { marks } : {}) });
const bold = (t) => text(t, [{ type: 'strong' }]);
const para = (...content) => ({ type: 'paragraph', content: content.flat().map((c) => (typeof c === 'string' ? text(c) : c)) });
const heading = (level, t) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const cell = (kind, t) => ({ type: kind, attrs: {}, content: [para(String(t))] });
const table = (headers, rows) => ({
  type: 'table',
  attrs: { isNumberColumnEnabled: false, layout: 'default' },
  content: [
    { type: 'tableRow', content: headers.map((h) => cell('tableHeader', h)) },
    ...rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell('tableCell', c)) })),
  ],
});
const plusminus = (x, f) => (fin(x) == null ? '' : ` ±${f(x)}`);

export function buildForecastComment(forecast, strain, today = new Date()) {
  const f = forecast || {};
  const flow = f.flow || {};
  const scen = Array.isArray(f.scenarios) ? f.scenarios.slice(0, 2) : [];
  if (!scen.length || !flow.project) throw new Error('No forecast to post: run Forecast first');
  const content = [];
  content.push(heading(3, flow.sample ? 'Flow forecast: sample data' : `Flow forecast: ${clean(flow.project, 12)}, ${clean(flow.from, 10)} to ${clean(flow.to, 10)}`));
  content.push(para(flow.sample ? 'Sample data: a made-up team, not read from Jira.' : `From ${num(flow.sampled, 0)} resolved issues; ${num(flow.arrivalPerDay, 1)} created and ${num(flow.throughputPerDay, 1)} resolved per day.`));
  content.push(
    table(
      ['Scenario', 'Issues/day', 'Team busy', 'Wait for a person', 'Pickup delay', 'Created to resolved'],
      scen.map((s) => {
        const ci = s.ci || {};
        return [
          clean(s.name, 30),
          num(s.arrivalPerDay, 1),
          pct(s.utilisation) + plusminus(ci.utilisation, (x) => num(x * 100, 1) + ' pts'),
          hours(s.queueDays) + plusminus(ci.queueDays, (x) => mins(x)),
          hours(s.pickupDays),
          num(s.inSystemDays, 2) + ' days' + plusminus(ci.inSystemDays, (x) => mins(x)),
        ];
      }),
    ),
  );
  const d = f.diff || {};
  if (d.utilisation && d.queueDays && d.inSystemDays && scen[1]) {
    const sg = (x) => (x >= 0 ? '+' : '−');
    content.push(
      para(
        bold(`${clean(scen[1].name, 30)} compared with Today`),
        ` (same random numbers in both): busy ${sg(d.utilisation.mean)}${num(Math.abs(d.utilisation.mean) * 100, 1)} points ±${num(d.utilisation.half * 100, 1)}, wait for a person ${sg(d.queueDays.mean)}${num(Math.abs(d.queueDays.mean) * 1440, 1)} min ±${num(d.queueDays.half * 1440, 1)}, created to resolved ${sg(d.inSystemDays.mean)}${num(Math.abs(d.inSystemDays.mean) * 1440, 1)} min ±${num(d.inSystemDays.half * 1440, 1)}. A difference larger than its ± is real.`,
      ),
    );
  }
  const st = strain && strain.strain;
  if (st && Array.isArray(st.points) && st.points.length) {
    content.push(heading(4, 'Where it breaks'));
    content.push(para(`The team saturates at ${num(st.saturationDemand, 2)}× today's demand (${num(st.saturationPerDay, 1)} issues a day, with ${num(st.people, 0)} people at once and ${num(st.workDays, 2)} days of work each). Past that the queue only grows.`));
    content.push(
      table(
        ['Demand', 'Issues/day', 'Team busy', 'Wait for a person (simulated)', 'Queueing formula', 'StochCraft says'],
        st.points.slice(0, 8).map((p) => [
          p.demand <= 1.0001 ? 'Today' : '×' + num(p.demand, 2),
          num(p.perDay, 1),
          pct(p.utilisation),
          hours(p.queueDays) + plusminus(p.ciQueueDays, (x) => num(x * 24, 1) + ' h'),
          p.formulaQueueDays == null ? 'n/a' : hours(p.formulaQueueDays),
          clean(p.engineStatus, 20) + (fin(p.peopleFor85) ? ` · needs ${num(p.peopleFor85, 0)} people` : ''),
        ]),
      ),
    );
  }
  const day = today.toISOString().slice(0, 10);
  content.push(para(text(`Simulated with StochCraft (the Flow forecast app) on ${day}. People working at once is an assumption unless it was set; ± is a 95% interval over the replications.`, [{ type: 'em' }])));
  return { version: 1, type: 'doc', content };
}

export const ISSUE_RE = /^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/;
