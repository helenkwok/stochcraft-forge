import Resolver from '@forge/resolver';
import { route } from '@forge/api';
import api from '@forge/api';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WASI } from 'wasi';
import { WASM_BASE64, MM1 } from './wasm-data';
import { buildModel, defaultCapacity, runModel } from './flow-model';

const resolver = new Resolver();

resolver.define('getText', () => 'Hello, world!');

// Spike: run the WASI build of stochcraft-cli inside a Forge function and report what happened.
async function probe() {
  const out = { steps: [] };
  const t0 = Date.now();
  const mark = (s) => out.steps.push(`${Date.now() - t0}ms ${s}`);
  try {
    out.node = process.version;
    const bytes = Buffer.from(WASM_BASE64, 'base64');
    mark(`wasm decoded ${bytes.length} bytes`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
    fs.writeFileSync(path.join(dir, 'mm1.bpmn'), MM1);
    mark(`tmp dir ${dir} written`);
    const wasi = new WASI({
      version: 'preview1',
      args: ['stochcraft-cli', 'run', '/work/mm1.bpmn', '--reps', '16', '--seed', '2026', '--threads', '1', '--format', 'json', '--out', '/work/result.json'],
      preopens: { '/work': dir },
      returnOnExit: true,
    });
    const module = await WebAssembly.compile(bytes);
    mark('wasm compiled');
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    mark('wasm instantiated');
    out.exitCode = wasi.start(instance);
    mark(`ran, exit ${out.exitCode}`);
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    const serve = r.elements.find((e) => e.id === 'serve').metrics;
    out.result = {
      replications: r.replications,
      utilisation: serve.utilisation.mean,
      mean_wait: serve.mean_wait.mean,
      mean_queue_length: serve.mean_queue_length.mean,
    };
    out.rssMB = Math.round(process.memoryUsage().rss / 1048576);
  } catch (e) {
    out.error = `${e && e.name}: ${e && e.message}`;
  }
  out.totalMs = Date.now() - t0;
  return out;
}


// Read a project's resolved issues with their status history, and summarise the flow the way a queue model needs it.
const KEY_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ISSUES = 300;

async function jira(path, body) {
  const res = await api.asUser().requestJira(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1));
  return { n: s.length, mean, sd, median: at(0.5), p85: at(0.85) };
};
const fmt = (x) => (x == null ? 'n/a' : x.mean.toFixed(2) + ' (median ' + x.median.toFixed(2) + ', p85 ' + x.p85.toFixed(2) + ')');

async function jiraFlow({ project, from, to }, prof) {
  const tj = Date.now(); const tick = (l, t) => prof && prof.push([l, Date.now() - t]);
  const key = String(project || '').toUpperCase();
  from = from || '2024-01-01';
  to = to || '2024-09-01';
  if (!KEY_RE.test(key)) throw new Error('Project key looks wrong');
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from >= to) throw new Error('Dates must be YYYY-MM-DD, from before to');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  const inWindow = (field) => `project = "${key}" AND ${field} >= "${from}" AND ${field} < "${to}"`;
  // the counts do not depend on the pages: ask for them alongside
  const counts = Promise.all([
    jira(route`/rest/api/3/search/approximate-count`, { jql: inWindow('created') }),
    jira(route`/rest/api/3/search/approximate-count`, { jql: inWindow('resolved') }),
  ]);
  const queue = [], service = [], lead = [];
  let token, read = 0;
  while (read < MAX_ISSUES) {
    const tp = Date.now();
    const page = await jira(route`/rest/api/3/search/jql`, {
      jql: inWindow('resolved') + ' ORDER BY resolved DESC',
      fields: ['created', 'resolutiondate'],
      expand: 'changelog',
      maxResults: Math.min(100, MAX_ISSUES - read),
      ...(token ? { nextPageToken: token } : {}),
    });
    tick('jira page of ' + (page.issues || []).length, tp);
    for (const i of page.issues || []) {
      read += 1;
      const created = Date.parse(i.fields.created), done = Date.parse(i.fields.resolutiondate);
      if (!(done >= created)) continue;
      let start = null;
      for (const h of (i.changelog?.histories || []).slice().sort((a, b) => Date.parse(a.created) - Date.parse(b.created))) {
        if (h.items.some((it) => it.field === 'status' && /progress/i.test(it.toString || ''))) { start = Date.parse(h.created); break; }
      }
      lead.push((done - created) / 86400000);
      if (start != null && start >= created && start <= done) {
        queue.push((start - created) / 86400000);
        service.push((done - start) / 86400000);
      }
    }
    token = page.nextPageToken;
    if (!token || !(page.issues || []).length) break;
  }
  const [arrived, resolved] = await counts;
  tick('jira counts and pages', tj);
  const r = {
    project: key, from, to, days, sampled: read,
    arrivals: arrived.count, resolved: resolved.count,
    arrivalPerDay: arrived.count / days, throughputPerDay: resolved.count / days,
    queueDays: stats(queue), serviceDays: stats(service), leadDays: stats(lead),
  };
  r.summary =
    `${key} ${from} to ${to} (${days} days): ${r.arrivals} created (${r.arrivalPerDay.toFixed(2)}/day), ${r.resolved} resolved (${r.throughputPerDay.toFixed(2)}/day). ` +
    `From ${read} resolved issues sampled: wait before work ${fmt(r.queueDays)} days, in progress ${fmt(r.serviceDays)} days, created to resolved ${fmt(r.leadDays)} days.`;
  return r;
}

resolver.define('jiraFlow', ({ payload }) => jiraFlow(payload || {}));


// What a team's flow would do: read the project, build the queue model from it, run it in StochCraft's engine
// (the WASI build) for what the team does today and for more demand, and report both next to what Jira shows.
const hw = (m) => (m && Number.isFinite(m.half_width) ? m.half_width : null);
const scenarioResult = (model, results) => {
  const el = (id) => results.elements.find((e) => e.id === id)?.metrics || {};
  const vals = (id) => results.values?.[id] || {};
  const work = el('work'), done = el('done');
  const timeKey = Object.keys(done).find((k) => /time_in_system/.test(k));
  const pickup = model.elements.find((e) => e.id === 'pickup');
  const server = model.elements.find((e) => e.id === 'work');
  return {
    people: server.capacity,
    arrivalPerDay: 1 / model.elements[0].interarrival.mean,
    utilisation: work.utilisation?.mean,
    queueDays: work.mean_wait?.mean,
    pickupDays: pickup ? pickup.duration.value : 0,
    waitDays: (work.mean_wait?.mean ?? 0) + (pickup ? pickup.duration.value : 0),
    queueLength: work.mean_queue_length?.mean,
    inSystemDays: timeKey ? done[timeKey].mean : null,
    // 95% half-widths over the replications
    ci: { utilisation: hw(work.utilisation), queueDays: hw(work.mean_wait), queueLength: hw(work.mean_queue_length), inSystemDays: timeKey ? hw(done[timeKey]) : null },
    // one value per replication, for paired comparison between scenarios
    perRep: { utilisation: vals('work').utilisation, queueDays: vals('work').mean_wait, inSystemDays: timeKey ? vals('done')[timeKey] : undefined },
    replications: results.replications,
  };
};

// Two-sided 95% t quantile for n-1 degrees of freedom (n replications).
const T95 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131, 19: 2.093, 29: 2.045, 49: 2.01 };
const tq = (df) => T95[df] ?? (df > 49 ? 1.98 : T95[Math.max(...Object.keys(T95).map(Number).filter((k) => k <= df))]);
// Paired difference b - a: replication i of both scenarios uses the same random stream (same seed and index), so the
// differences cancel most of the noise. Returns the mean difference with its 95% half-width.
function paired(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length < 2) return null;
  const d = a.map((x, i) => b[i] - x);
  const n = d.length, mean = d.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1));
  return { mean, half: tq(n - 1) * sd / Math.sqrt(n) };
}
const compare = (a, b) => ({
  utilisation: paired(a.perRep.utilisation, b.perRep.utilisation),
  queueDays: paired(a.perRep.queueDays, b.perRep.queueDays),
  inSystemDays: paired(a.perRep.inSystemDays, b.perRep.inSystemDays),
});

async function forecast(payload) {
  const prof = []; const tf = Date.now();
  const flow = await jiraFlow(payload, prof);
  const run = async (label, model, reps) => { const timing = {}; const t = Date.now(); const res = await runModel(wasm, model, reps, timing); prof.push([`run ${label}${reps ? ' x' + reps : ''}`, Date.now() - t, timing]); return res; };
  if (!flow.serviceDays || !flow.queueDays || !(flow.arrivalPerDay > 0)) throw new Error('No resolved issues with an In Progress step in that window');
  const demand = Math.min(5, Math.max(0.1, Number(payload.demand) || 1.2));
  const people = Math.min(50, Math.max(1, Math.round(Number(payload.capacity) || 0) || defaultCapacity(flow.arrivalPerDay, flow.serviceDays.mean)));
  const base = { arrivalPerDay: flow.arrivalPerDay, serviceMean: flow.serviceDays.mean, serviceSd: flow.serviceDays.sd, capacity: people };
  const tw = Date.now();
  const wasm = await WebAssembly.compile(Buffer.from(WASM_BASE64, 'base64'));
  prof.push(['wasm decode and compile once', Date.now() - tw]);
  const t0 = Date.now();
  // 1. Capacity alone: how long would issues queue for a person? Jira shows a longer wait; the rest is a fixed pickup delay.
  const plain = scenarioResult(buildModel({ ...base }), await run('capacity only', buildModel({ ...base }), 6));
  const pickupDays = Math.max(0, flow.queueDays.mean - plain.queueDays);
  // 2. Today and more demand, both with that pickup delay.
  const scenarios = [];
  for (const [name, d] of [['Today', 1], [`Demand x${demand}`, demand]]) {
    const model = buildModel({ ...base, demand: d, pickupDays, name: `${flow.project} ${name}` });
    scenarios.push({ name, ...scenarioResult(model, await run(name, model)) });
  }
  // What breaks first: raise demand until the team saturates. Saturation is where the people at once are busy 100% of the
  // time (arrivals x work time = people); a queue then grows without bound. Between today and that point, a short sweep
  // (6 replications each, to stay inside the function time limit) shows where waiting for a person gets long.
  const rhoToday = (flow.arrivalPerDay * flow.serviceDays.mean) / people;
  const strain = { rhoToday, saturationDemand: 1 / rhoToday, saturationPerDay: people / flow.serviceDays.mean, workDays: flow.serviceDays.mean, points: [] };
  for (const rho of [0.75, 0.85, 0.92, 0.97]) {
    const d = rho / rhoToday;
    if (d <= 1.02) continue;
    const model = buildModel({ ...base, demand: d, pickupDays, name: `${flow.project} Demand x${d.toFixed(2)}` });
    const r = scenarioResult(model, await run('sweep x' + d.toFixed(2), model, 6));
    strain.points.push({ demand: d, perDay: r.arrivalPerDay, utilisation: r.utilisation, queueDays: r.queueDays, ciQueueDays: r.ci.queueDays });
  }
  strain.firstBusy85 = strain.points.find((x) => x.utilisation >= 0.85) || null;
  strain.firstWaitLongerThanWork = strain.points.find((x) => x.queueDays > flow.serviceDays.mean) || null;
  const diff = compare(scenarios[0], scenarios[1]);
  const f = (x, n = 2) => (x == null ? 'n/a' : Number(x).toFixed(n));
  const h = (days) => f(days * 24, 1) + ' h';
  const pm = (x, n) => (x == null ? '' : ' ±' + f(x, n));
  const line = (s) => `${s.name}: ${f(s.arrivalPerDay, 1)} issues/day, ${s.people} working at once: busy ${f(s.utilisation * 100, 0)}%${pm(s.ci.utilisation * 100, 1)}, waits ${h(s.waitDays)} (±${f(s.ci.queueDays * 1440, 1)} min) (${h(s.queueDays)} for a person + ${h(s.pickupDays)} pickup), ${f(s.inSystemDays, 2)} days (±${f(s.ci.inSystemDays * 1440, 1)} min) created to resolved.`;
  const dline = diff.queueDays && diff.utilisation && diff.inSystemDays
    ? `${scenarios[1].name} compared with Today (paired, same random numbers): busy ${diff.utilisation.mean >= 0 ? '+' : ''}${f(diff.utilisation.mean * 100, 1)} points ±${f(diff.utilisation.half * 100, 1)}, wait for a person ${diff.queueDays.mean >= 0 ? '+' : ''}${f(diff.queueDays.mean * 1440, 1)} min ±${f(diff.queueDays.half * 1440, 1)}, created to resolved ${diff.inSystemDays.mean >= 0 ? '+' : ''}${f(diff.inSystemDays.mean * 1440, 1)} min ±${f(diff.inSystemDays.half * 1440, 1)}. A difference larger than its ± is real, not noise.`
    : '';
  const sline = `What breaks first: the team saturates at ${f(strain.saturationDemand, 2)}x today's demand (${f(strain.saturationPerDay, 1)} issues/day with ${people} working at once, each issue taking ${f(strain.workDays, 2)} days of work); past that the queue only grows. ` +
    (strain.points.length ? 'On the way: ' + strain.points.map((x) => `x${f(x.demand, 2)} (${f(x.perDay, 1)}/day): busy ${f(x.utilisation * 100, 0)}%, wait for a person ${h(x.queueDays)} ±${f(x.ciQueueDays * 24, 1)} h`).join('; ') + '. ' : 'Today is already at that limit. ') +
    (strain.firstWaitLongerThanWork ? `Issues first wait longer for a person than the work itself takes at about x${f(strain.firstWaitLongerThanWork.demand, 2)}.` : 'Within the range tested waiting for a person stays shorter than the work itself.');
  const check = `Check against Jira today: wait ${h(flow.queueDays.mean)} (model ${h(scenarios[0].waitDays)}), created to resolved ${f(flow.leadDays.mean)} days (model ${f(scenarios[0].inSystemDays)}).`;
  return {
    flow, scenarios, diff, strain, plain, pickupDays,
    assumptions: [
      `People working at once is not in Jira: ${payload.capacity ? 'you set it to ' + people : 'estimated as ' + people + ' so that today runs at about 70 percent busy'}.`,
      `Jira's wait before work (${h(flow.queueDays.mean)}) is longer than queueing for a person explains (${h(plain.queueDays)}), so the rest, ${h(pickupDays)}, is modelled as a fixed pickup delay that more demand does not change.`,
      `Every figure is the mean of ${scenarios[0].replications} replications with its 95% interval (±). Today and the other scenario use the same random numbers replication by replication, so their difference is much sharper than the two intervals suggest.`,
      'Issues take as long as the sampled In Progress times (log-normal with their mean and spread), and arrive at random at the rate Jira shows.',
    ],
    runMs: Date.now() - t0,
    profile: prof, totalMs: Date.now() - tf,
    summary: flow.summary + '\n' + scenarios.map(line).join('\n') + (dline ? '\n' + dline : '') + '\n' + sline + '\n' + check + ' (' + scenarios[0].replications + ' replications each; ' + (Date.now() - t0) + ' ms)' ,
  };
}

resolver.define('forecast', ({ payload }) => forecast(payload || {}));

resolver.define('simulate', () => probe());

export const handler = resolver.getDefinitions();

// The Rovo agent's action: the same forecast, returned as plain data for the agent to explain.
export async function forecastAction(payload) {
  const input = payload || {};
  const r = await forecast({ project: input.project, from: input.from, to: input.to, demand: input.demand, capacity: input.people });
  const n = (x, d) => Number(x).toFixed(d);
  const h = (days) => `${n(days * 24, 1)} h`;
  // Every number the agent should quote, already rounded and written out: it copies these and calculates nothing.
  const table = r.scenarios.map((s) => ({
    scenario: s.name,
    issuesPerDay: n(s.arrivalPerDay, 1),
    teamBusy: `${n(s.utilisation * 100, 0)}% (±${n(s.ci.utilisation * 100, 1)} points)`,
    peopleWorkingAtOnce: String(s.people),
    waitForAPerson: `${h(s.queueDays)} (±${n(s.ci.queueDays * 1440, 1)} min)`,
    pickupDelay: h(s.pickupDays),
    totalWait: h(s.waitDays),
    createdToResolved: `${n(s.inSystemDays, 2)} days (±${n(s.ci.inSystemDays * 1440, 1)} min)`,
  }));
  const sg = (x) => (x >= 0 ? '+' : '-');
  const d = r.diff;
  const sameStreams = d.utilisation && d.queueDays && d.inSystemDays
    ? {
        comparison: `${r.scenarios[1].name} compared with Today, replication by replication with the same random numbers`,
        teamBusy: `${sg(d.utilisation.mean)}${n(Math.abs(d.utilisation.mean) * 100, 1)} points (±${n(d.utilisation.half * 100, 1)})`,
        waitForAPerson: `${sg(d.queueDays.mean)}${n(Math.abs(d.queueDays.mean) * 1440, 1)} min (±${n(d.queueDays.half * 1440, 1)})`,
        createdToResolved: `${sg(d.inSystemDays.mean)}${n(Math.abs(d.inSystemDays.mean) * 1440, 1)} min (±${n(d.inSystemDays.half * 1440, 1)})`,
        howToRead: 'A difference larger than its ± is real; one smaller than its ± cannot be told apart from noise.',
      }
    : null;
  const whatBreaksFirst = {
    saturatesAt: `${n(r.strain.saturationDemand, 2)}x today's demand (${n(r.strain.saturationPerDay, 1)} issues a day)`,
    meaning: `With ${r.scenarios[0].people} people working at once and ${n(r.strain.workDays, 2)} days of work per issue, the team is busy 100% of the time at that demand. Beyond it the queue grows without limit.`,
    steps: r.strain.points.map((x) => ({ demand: `${n(x.demand, 2)}x (${n(x.perDay, 1)} issues a day)`, teamBusy: `${n(x.utilisation * 100, 0)}%`, waitForAPerson: `${h(x.queueDays)} (±${n(x.ciQueueDays * 24, 1)} h)` })),
    firstTimeWaitingIsLongerThanTheWork: r.strain.firstWaitLongerThanWork ? `at about ${n(r.strain.firstWaitLongerThanWork.demand, 2)}x` : 'not reached before saturation in the steps tested',
    note: 'Steps use 6 replications each, so their ± is wider than in the table; saturation is exact arithmetic, not simulated.',
  };
  return {
    project: r.flow.project,
    window: `${r.flow.from} to ${r.flow.to}`,
    copyTheseValuesExactly: {
      scenarioTable: table,
      pairedDifference: sameStreams,
      whatBreaksFirst,
      jiraToday: {
        issuesCreatedPerDay: n(r.flow.arrivalPerDay, 1),
        issuesResolvedPerDay: n(r.flow.throughputPerDay, 1),
        waitBeforeWork: h(r.flow.queueDays.mean),
        timeInProgress: `${n(r.flow.serviceDays.mean, 2)} days`,
        createdToResolved: `${n(r.flow.leadDays.mean, 2)} days`,
      },
    },
    warnings: [
      ...(r.flow.throughputPerDay < 0.9 * r.flow.arrivalPerDay
        ? [`In this window Jira shows fewer issues resolved (${n(r.flow.throughputPerDay, 1)} a day) than created (${n(r.flow.arrivalPerDay, 1)} a day). Issues may be stuck unresolved or the window may include a period when nothing was resolved. The model uses the issues that were resolved, so the real waits could be longer than forecast.`]
        : []),
      ...(r.flow.sampled < 50 ? [`Only ${r.flow.sampled} resolved issues were available to learn from, so the forecast is rough.`] : []),
    ],
    assumptions: r.assumptions,
  };
}
