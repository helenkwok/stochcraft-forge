# StochCraft for Jira

A Forge app (Jira project page) that reads a project's issue history and shows what a change in demand would do to the team's waiting time and busyness. It runs [StochCraft](https://github.com/helenkwok/StochCraft), an open-source discrete-event simulation engine, to answer it.

## What it does

The panel shows StochCraft's browser app, with a bar above it. Give the bar a project key and a date range and press **Forecast**. Two Forge functions read the project's resolved issues with their status history (as the person viewing the page, scope `read:jira-work`), work out how often issues arrive and how long they stay In Progress, build a queue model from that and run it in StochCraft's engine. Results open in two tabs:

- **Forecast**: today and a what-if (more demand, default ×1.2), each with a 95% interval over the replications; the difference between the two as a paired comparison (the same random numbers in both, so the difference is far sharper than two separate intervals); what Jira shows next to what the model gives; and which distribution (exponential, log-normal, gamma, Weibull) fits the measured work times best.
- **Where it breaks**: the demand at which the team is busy all the time, and a short simulated sweep up to it, with StochCraft's own capacity check for each step (its status, and the people needed to stay under 85% busy) and the queueing formula beside each simulated wait.

**Post to Jira** adds the forecast as a comment, as you, on an issue you name (scope `write:jira-work`). Nothing else is written, and the app stores nothing (see `PRIVACY.md`).

## The Rovo agent

`Flow forecaster` is a Rovo agent (module `rovo:agent`) with two actions, `forecast-flow` and `strain-flow`, that run the same two calls and return the numbers for the agent to explain: ask it "What happens to waiting times if demand grows 20 percent?" and give it a project key. The agent is told to report only what the actions return, and to always state the assumptions.

## How it works

- The engine runs inside the Forge function: the WASI build of `stochcraft-cli` (built by the "CLI on WASI" workflow of helenkwok/StochCraft) is embedded and run with `node:wasi`, no native code and no threads.
- The browser panel is StochCraft's own web build. Forge serves worker scripts with a default content security policy that blocks WebAssembly, so `static/stochcraft/index.html` starts the worker from a `blob:` URL, which inherits the page's policy (`unsafe-eval` and `blob:` are declared in `manifest.yml`).
- The model: issues arrive at random at the rate Jira shows (times the demand factor), wait for a person, and take the sampled In Progress time (log-normal). Jira's wait before work is usually longer than queueing for a person explains, so the remainder is a fixed pickup delay that more demand does not change.

## Limits

- How many people work at once is not in Jira. It is blank by default and estimated so that today runs at about 70 percent busy; you can type your own number.
- The check against Jira is partly circular: service times come from the same issues.
- The pickup delay is one fixed number; real data may show spread.
- It samples up to 300 resolved issues per run.
- Each simulated step of "Where it breaks" is one year, so near saturation the queueing formula (a long-run figure) is higher than the simulation.

## Build

```bash
scripts/fetch-stochcraft-web.sh                       # StochCraft's browser build into static/stochcraft
npm install --ignore-scripts && npm run build:ui      # the Jira bar (needs esbuild, a dev dependency)
gh run download <run id> -R helenkwok/StochCraft -n stochcraft-cli-wasip1
node scripts/make-wasm-data.mjs <downloaded>/target/wasm32-wasip1/release/stochcraft-cli.wasm <StochCraft checkout>/tests/models/mm1.bpmn
forge deploy -e production && forge install -e production -s <site>.atlassian.net -p Jira
```

## Privacy and terms

`PRIVACY.md` says what the app reads, does and keeps; `TERMS.md` has the terms. Questions: https://github.com/helenkwok/StochCraft/issues

## Licence

MIT OR Apache-2.0, like StochCraft (see `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`).
