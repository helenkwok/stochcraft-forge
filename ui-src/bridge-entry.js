// Built into static/stochcraft/jira-bar-<hash>.js: the Jira bar above StochCraft, using the Forge bridge.
// One compact row of inputs; the results open in their own panel (tables, no raw text) above the StochCraft window.
import { invoke, view } from '@forge/bridge';

const $ = (id) => document.getElementById(id);
const bar = $('jira-bar');
const key = $('jira-key');
const from = $('jira-from');
const to = $('jira-to');
const people = $('jira-people');
const demand = $('jira-demand');
const go = $('jira-load');
const status = $('jira-status');
const results = $('jira-results');
const toggle = $('jira-toggle');

const IDLE = "Reads a project's resolved issues and runs them through StochCraft.";

// ---- formatting (the numbers arrive unrounded; days are the unit)
const num = (x, n = 2) => (x == null || !Number.isFinite(Number(x)) ? 'n/a' : Number(x).toFixed(n));
const hours = (d) => num(d * 24, 1) + ' h';
const mins = (d) => num(d * 1440, 1) + ' min';
const pct = (x) => num(x * 100, 0) + '%';
const signed = (x, text) => (x >= 0 ? '+' : '−') + text.replace(/^-/, '');

// ---- tiny DOM helpers: text only, never innerHTML
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
};
const pm = (text) => el('span', { class: 'pm', title: '95% interval over the replications' }, ' ±' + text);
const table = (headers, rows, rowClass) =>
  el(
    'table',
    {},
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, rows.map((r, i) => el('tr', { class: (rowClass && rowClass(i)) || '' }, r.map((c, j) => el(j === 0 ? 'th' : 'td', j === 0 ? { scope: 'row' } : {}, c))))),
  );
const section = (title, ...kids) => el('section', {}, el('h3', {}, title), kids);
const note = (text, cls) => el('p', { class: cls || 'note' }, text);

// ---- the two answers
function forecastView(r) {
  const flow = r.flow;
  const out = [];
  const warn = [];
  if (flow.throughputPerDay < 0.9 * flow.arrivalPerDay)
    warn.push(`In this window Jira shows fewer issues resolved (${num(flow.throughputPerDay, 1)} a day) than created (${num(flow.arrivalPerDay, 1)} a day). The model learns from resolved issues only, so real waits may be longer than forecast.`);
  if (flow.sampled < 50) warn.push(`Only ${flow.sampled} resolved issues were available to learn from, so the forecast is rough.`);
  warn.forEach((w) => out.push(note(w, 'warn')));
  out.push(
    note(
      `${flow.project}, ${flow.from} to ${flow.to} (${flow.days} days): ${flow.arrivals.toLocaleString('en')} created (${num(flow.arrivalPerDay, 1)}/day), ${flow.resolved.toLocaleString('en')} resolved (${num(flow.throughputPerDay, 1)}/day). Work times from ${flow.sampled} resolved issues.`,
    ),
  );
  out.push(
    section(
      'Today, and with more demand',
      table(
        ['Scenario', 'Issues/day', 'Team busy', 'Wait for a person', 'Pickup delay', 'Created to resolved'],
        r.scenarios.map((s) => [
          s.name,
          num(s.arrivalPerDay, 1),
          [pct(s.utilisation), pm(num(s.ci.utilisation * 100, 1) + ' pts')],
          [hours(s.queueDays), pm(mins(s.ci.queueDays))],
          hours(s.pickupDays),
          [num(s.inSystemDays, 2) + ' days', pm(mins(s.ci.inSystemDays))],
        ]),
      ),
    ),
  );
  const d = r.diff;
  if (d && d.utilisation && d.queueDays && d.inSystemDays) {
    out.push(
      el(
        'p',
        { class: 'callout' },
        el('b', {}, `${r.scenarios[1].name} compared with Today`),
        ' (the same random numbers in both, so the difference is sharp): ',
        `busy ${signed(d.utilisation.mean, num(d.utilisation.mean * 100, 1) + ' points')}`,
        pm(num(d.utilisation.half * 100, 1)),
        `, wait for a person ${signed(d.queueDays.mean, mins(d.queueDays.mean))}`,
        pm(num(d.queueDays.half * 1440, 1)),
        `, created to resolved ${signed(d.inSystemDays.mean, mins(d.inSystemDays.mean))}`,
        pm(num(d.inSystemDays.half * 1440, 1)),
        '. A difference larger than its ± is real, not noise.',
      ),
    );
  }
  const checks = [
    `Jira today: wait ${hours(flow.queueDays.mean)}, created to resolved ${num(flow.leadDays.mean, 2)} days. Model today: wait ${hours(r.scenarios[0].waitDays)}, created to resolved ${num(r.scenarios[0].inSystemDays, 2)} days.`,
  ];
  if (r.fit) checks.push(`Work times (${r.fit.n} issues): ${r.fit.best} fits best; AIC gap to the others: ${r.fit.ranking.slice(1).map((o) => o.family + ' +' + num(o.deltaAic, 0)).join(', ')}. The slowest 15% take longer than ${num(r.fit.observedP85, 2)} days (log-normal says ${num(r.fit.lognormalP85, 2)}).`);
  out.push(section('Does the model match Jira?', checks.map((c) => note(c))));
  out.push(el('details', {}, el('summary', {}, 'Assumptions'), el('ul', {}, r.assumptions.map((a) => el('li', {}, a)))));
  return out;
}

function strainView(s) {
  const st = s.strain;
  const out = [];
  const ahead = st.points.filter((p) => p.demand > 1.0001);
  out.push(
    note(
      `The team saturates at ${num(st.saturationDemand, 2)}× today's demand (${num(st.saturationPerDay, 1)} issues a day, with ${st.people} people at once and ${num(st.workDays, 2)} days of work each). Past that the queue only grows.`,
      'lead',
    ),
  );
  if (!ahead.length) {
    out.push(note('Today is already at that limit.', 'warn'));
  } else {
    out.push(note('People needed to stay under 85% busy (StochCraft capacity check): ' + st.points.map((p) => `${p.demand <= 1.0001 ? 'today' : '×' + num(p.demand, 2)} ${p.peopleFor85 ?? st.people}`).join(', ') + ` (you have ${st.people}).`));
    out.push(
      table(
        ['Demand', 'Issues/day', 'Team busy', 'Wait for a person (simulated)', 'Queueing formula', 'StochCraft says'],
        st.points.map((p) => [
          p.demand <= 1.0001 ? 'Today' : '×' + num(p.demand, 2),
          num(p.perDay, 1),
          pct(p.utilisation),
          [hours(p.queueDays), pm(num(p.ciQueueDays * 24, 1) + ' h')],
          p.formulaQueueDays == null ? 'n/a' : hours(p.formulaQueueDays),
          p.engineStatus + (p.peopleFor85 ? ` · needs ${p.peopleFor85} people` : ''),
        ]),
        (i) => (st.points[i].queueDays > st.workDays ? 'hot' : ''),
      ),
    );
    out.push(
      note(
        st.firstWaitLongerThanWork
          ? `Highlighted rows: issues wait longer for a person than the work itself takes, from about ×${num(st.firstWaitLongerThanWork.demand, 2)}.`
          : 'Within the range tested, waiting for a person stays shorter than the work itself.',
      ),
    );
  }
  out.push(el('details', {}, el('summary', {}, 'How to read this'), el('ul', {}, s.assumptions.map((a) => el('li', {}, a)))));
  return out;
}

// ---- errors in plain words
function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (/timed out/i.test(m)) return 'That took longer than Forge allows (25 seconds). Try a shorter date window.';
  if (/No resolved issues/i.test(m)) return 'No resolved issues with an In Progress step in that window. Try an earlier or wider window, or another project.';
  if (/Project key looks wrong/i.test(m)) return 'The project key should be 2 to 10 capital letters or digits, like PLAT.';
  if (/Dates must be/i.test(m)) return 'Use dates like 2024-01-01, with the start before the end.';
  if (/Jira (401|403)/.test(m)) return 'Jira did not let you read that project. You need permission to browse it.';
  if (/Jira (400|404)/.test(m) && /comment|issue/i.test(m)) return 'Jira could not find that issue, or you may not comment on it.';
  if (/Jira (400|404)/.test(m)) return 'Jira could not find that project or window. Check the project key.';
  return 'Something went wrong: ' + m.replace(/^There was an error invoking the function - /, '').slice(0, 200);
}

// ---- inputs, checked before anything is sent
function readInput() {
  const k = key.value.trim().toUpperCase();
  const f = from.value.trim();
  const t = to.value.trim();
  const dm = Number(demand.value);
  const ppl = people.value.trim();
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(k)) return { bad: key, why: 'The project key should be 2 to 10 capital letters or digits, like PLAT.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || f >= t) return { bad: from, why: 'Use dates like 2024-01-01, with the start before the end.' };
  if (!(dm >= 0.1 && dm <= 5)) return { bad: demand, why: 'Demand is a multiplier between 0.1 and 5, for example 1.2 for 20 percent more.' };
  if (ppl !== '' && !(Number.isInteger(Number(ppl)) && Number(ppl) >= 1 && Number(ppl) <= 50)) return { bad: people, why: 'People working at once is a whole number from 1 to 50, or leave it empty to estimate it.' };
  return { input: { project: k, from: f, to: t, capacity: ppl }, demand: String(dm) };
}

// ---- write-back: the forecast as a comment on an issue
const slim = (r) => r && JSON.parse(JSON.stringify(r, (k, x) => (k === 'serviceSample' || k === 'perRep' || k === 'profile' ? undefined : x)));
function postRow(project) {
  const issue = el('input', { value: project + '-1', 'aria-label': 'Issue to comment on', autocomplete: 'off', class: 'issue' });
  const post = el('button', { type: 'button' }, 'Post to Jira');
  const msg = el('span', { role: 'status', 'aria-live': 'polite' });
  post.addEventListener('click', async () => {
    const k = issue.value.trim().toUpperCase();
    msg.className = '';
    if (!/^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/.test(k)) {
      issue.setAttribute('aria-invalid', 'true');
      msg.className = 'err';
      msg.textContent = 'An issue key looks like PLAT-123.';
      return;
    }
    issue.removeAttribute('aria-invalid');
    post.disabled = true;
    msg.textContent = 'Posting…';
    try {
      const r = await invoke('postForecast', { issueKey: k, forecast: slim(window.__jiraFlow), strain: slim(window.__jiraStrain) });
      let url = null;
      try { url = `${(await view.getContext()).siteUrl}/browse/${r.issue}?focusedCommentId=${r.id}`; } catch (e) { /* no link outside Jira */ }
      msg.replaceChildren('Posted as you on ', url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, r.issue) : r.issue, '.');
      window.__jiraPosted = r;
    } catch (e) {
      msg.className = 'err';
      msg.textContent = friendly(e);
    }
    post.disabled = false;
  });
  return el('div', { class: 'postrow' }, 'Save this forecast in Jira as a comment on ', issue, post, msg);
}

let running = false;
async function load() {
  if (running) return;
  for (const i of [key, from, to, people, demand]) i.removeAttribute('aria-invalid');
  const v = readInput();
  if (v.bad) {
    v.bad.setAttribute('aria-invalid', 'true');
    v.bad.focus();
    status.textContent = v.why;
    status.className = 'err';
    return;
  }
  running = true;
  go.disabled = true;
  status.className = '';
  status.textContent = 'Reading Jira and running StochCraft, about 12 seconds…';
  const t0 = Date.now();
  const secForecast = el('div', { class: 'pending' }, 'Working out the forecast…');
  const secStrain = el('div', { class: 'pending' }, 'Working out where it breaks…');
  const paneF = el('div', { role: 'tabpanel' }, secForecast);
  const paneS = el('div', { role: 'tabpanel', hidden: '' }, secStrain);
  const tabF = el('button', { type: 'button', role: 'tab', 'aria-selected': 'true' }, 'Forecast');
  const tabS = el('button', { type: 'button', role: 'tab', 'aria-selected': 'false' }, 'Where it breaks');
  const pick = (first) => {
    paneF.hidden = !first;
    paneS.hidden = first;
    tabF.setAttribute('aria-selected', String(first));
    tabS.setAttribute('aria-selected', String(!first));
  };
  tabF.addEventListener('click', () => pick(true));
  tabS.addEventListener('click', () => pick(false));
  results.replaceChildren(el('div', { role: 'tablist', class: 'tabs' }, tabF, tabS), paneF, paneS);
  results.hidden = false;
  toggle.hidden = false;
  toggle.textContent = 'Hide results';
  toggle.setAttribute('aria-expanded', 'true');
  const show = (box, nodes) => box.replaceWith(el('div', {}, nodes));
  const fail = (box, e) => box.replaceWith(note(friendly(e), 'warn'));
  // Two calls at the same time: each reads Jira itself, so the wait is the longer one, not the sum.
  const a = invoke('forecast', { ...v.input, demand: v.demand }).then(
    (r) => { window.__jiraFlow = r; show(secForecast, forecastView(r)); },
    (e) => fail(secForecast, e),
  );
  const c = invoke('strain', v.input).then(
    (r) => { window.__jiraStrain = r; show(secStrain, strainView(r)); },
    (e) => fail(secStrain, e),
  );
  await Promise.all([a, c]);
  if (window.__jiraFlow) results.append(postRow(v.input.project));
  status.textContent = `Done in ${((Date.now() - t0) / 1000).toFixed(0)} s.`;
  go.disabled = false;
  running = false;
}

go.addEventListener('click', load);
for (const i of [key, from, to, people, demand]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
toggle.addEventListener('click', () => {
  results.hidden = !results.hidden;
  toggle.textContent = results.hidden ? 'Show results' : 'Hide results';
  toggle.setAttribute('aria-expanded', String(!results.hidden));
});
status.textContent = IDLE;
window.loadJiraFlow = load;
bar.hidden = false;
