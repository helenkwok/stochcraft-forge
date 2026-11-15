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

async function jiraFlow({ project, from, to }) {
  const key = String(project || '').toUpperCase();
  from = from || '2024-01-01';
  to = to || '2024-09-01';
  if (!KEY_RE.test(key)) throw new Error('Project key looks wrong');
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from >= to) throw new Error('Dates must be YYYY-MM-DD, from before to');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  const inWindow = (field) => `project = "${key}" AND ${field} >= "${from}" AND ${field} < "${to}"`;
  const [arrived, resolved] = await Promise.all([
    jira(route`/rest/api/3/search/approximate-count`, { jql: inWindow('created') }),
    jira(route`/rest/api/3/search/approximate-count`, { jql: inWindow('resolved') }),
  ]);
  const queue = [], service = [], lead = [];
  let token, read = 0;
  while (read < MAX_ISSUES) {
    const page = await jira(route`/rest/api/3/search/jql`, {
      jql: inWindow('resolved') + ' ORDER BY resolved DESC',
      fields: ['created', 'resolutiondate'],
      expand: 'changelog',
      maxResults: Math.min(100, MAX_ISSUES - read),
      ...(token ? { nextPageToken: token } : {}),
    });
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
const scenarioResult = (model, results) => {
  const el = (id) => results.elements.find((e) => e.id === id)?.metrics || {};
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
    replications: results.replications,
  };
};

async function forecast(payload) {
  const flow = await jiraFlow(payload);
  if (!flow.serviceDays || !flow.queueDays || !(flow.arrivalPerDay > 0)) throw new Error('No resolved issues with an In Progress step in that window');
  const demand = Math.min(5, Math.max(0.1, Number(payload.demand) || 1.2));
  const people = Math.min(50, Math.max(1, Math.round(Number(payload.capacity) || 0) || defaultCapacity(flow.arrivalPerDay, flow.serviceDays.mean)));
  const base = { arrivalPerDay: flow.arrivalPerDay, serviceMean: flow.serviceDays.mean, serviceSd: flow.serviceDays.sd, capacity: people };
  const wasm = Buffer.from(WASM_BASE64, 'base64');
  const t0 = Date.now();
  // 1. Capacity alone: how long would issues queue for a person? Jira shows a longer wait; the rest is a fixed pickup delay.
  const plain = scenarioResult(buildModel({ ...base }), await runModel(wasm, buildModel({ ...base })));
  const pickupDays = Math.max(0, flow.queueDays.mean - plain.queueDays);
  // 2. Today and more demand, both with that pickup delay.
  const scenarios = [];
  for (const [name, d] of [['Today', 1], [`Demand x${demand}`, demand]]) {
    const model = buildModel({ ...base, demand: d, pickupDays, name: `${flow.project} ${name}` });
    scenarios.push({ name, ...scenarioResult(model, await runModel(wasm, model)) });
  }
  const f = (x, n = 2) => (x == null ? 'n/a' : Number(x).toFixed(n));
  const h = (days) => f(days * 24, 1) + ' h';
  const line = (s) => `${s.name}: ${f(s.arrivalPerDay, 1)} issues/day, ${s.people} working at once: busy ${f(s.utilisation * 100, 0)}%, waits ${h(s.waitDays)} (${h(s.queueDays)} for a person + ${h(s.pickupDays)} pickup), ${f(s.inSystemDays, 2)} days created to resolved.`;
  const check = `Check against Jira today: wait ${h(flow.queueDays.mean)} (model ${h(scenarios[0].waitDays)}), created to resolved ${f(flow.leadDays.mean)} days (model ${f(scenarios[0].inSystemDays)}).`;
  return {
    flow, scenarios, plain, pickupDays,
    assumptions: [
      `People working at once is not in Jira: ${payload.capacity ? 'you set it to ' + people : 'estimated as ' + people + ' so that today runs at about 70 percent busy'}.`,
      `Jira's wait before work (${h(flow.queueDays.mean)}) is longer than queueing for a person explains (${h(plain.queueDays)}), so the rest, ${h(pickupDays)}, is modelled as a fixed pickup delay that more demand does not change.`,
      'Issues take as long as the sampled In Progress times (log-normal with their mean and spread), and arrive at random at the rate Jira shows.',
    ],
    runMs: Date.now() - t0,
    summary: flow.summary + '\n' + scenarios.map(line).join('\n') + '\n' + check + ' (' + scenarios[0].replications + ' replications each; ' + (Date.now() - t0) + ' ms)',
  };
}

resolver.define('forecast', ({ payload }) => forecast(payload || {}));

resolver.define('simulate', () => probe());

export const handler = resolver.getDefinitions();
