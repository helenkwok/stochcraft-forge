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
  out.textContent = 'Reading Jira and running the simulation…';
  try {
    const r = await invoke('forecast', { project: key.value.trim(), from: from.value, to: to.value, capacity: people.value, demand: demand.value });
    window.__jiraFlow = r;
    out.textContent = r.summary;
  } catch (e) {
    out.textContent = 'Error: ' + (e && e.message ? e.message : String(e));
  }
}
document.getElementById('jira-load').addEventListener('click', load);
window.loadJiraFlow = load;
bar.hidden = false;
