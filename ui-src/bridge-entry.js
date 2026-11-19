// Built into static/stochcraft/jira-bar.js: the Jira bar above StochCraft, using the Forge bridge.
import { invoke } from '@forge/bridge';

const bar = document.getElementById('jira-bar');
const out = document.getElementById('jira-out');
const key = document.getElementById('jira-key');
const from = document.getElementById('jira-from');
const to = document.getElementById('jira-to');
const people = document.getElementById('jira-people');
const demand = document.getElementById('jira-demand');

async function load() {
  const parts = ['Reading Jira and running the simulation…', 'Working out where it breaks…'];
  const show = () => { out.textContent = parts.join('\n\n'); };
  show();
  const input = { project: key.value.trim(), from: from.value, to: to.value, capacity: people.value };
  const done = (i, text) => { parts[i] = text; show(); };
  // Two calls at the same time: each reads Jira itself, so the wait is the longer one, not the sum.
  const a = invoke('forecast', { ...input, demand: demand.value }).then((r) => { window.__jiraFlow = r; done(0, r.summary); }, (e) => done(0, 'Error: ' + (e && e.message ? e.message : String(e))));
  const c = invoke('strain', input).then((r) => { window.__jiraStrain = r; done(1, r.summary); }, (e) => done(1, 'Error (where it breaks): ' + (e && e.message ? e.message : String(e))));
  await Promise.all([a, c]);
}
document.getElementById('jira-load').addEventListener('click', load);
window.loadJiraFlow = load;
bar.hidden = false;
