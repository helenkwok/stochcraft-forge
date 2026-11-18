import fs from 'fs';
import os from 'os';
import path from 'path';
import { WASI } from 'wasi';

// A team's flow as a StochCraft model: tickets arrive at the rate Jira shows (times demand),
// and are worked by `capacity` people at once, each ticket taking the time Jira shows
// (log-normal with the sampled mean and spread). Times are in days.
export function buildModel({ arrivalPerDay, serviceMean, serviceSd, capacity, demand = 1, pickupDays = 0, name = 'Jira flow' }) {
  const rate = arrivalPerDay * demand;
  const service =
    serviceSd > 0
      ? { type: 'log_normal', mean: serviceMean, std_dev: serviceSd }
      : { type: 'exponential', mean: serviceMean };
  const pickup = pickupDays > 0;
  return {
    name,
    elements: [
      { id: 'arrive', kind: 'source', name: 'Issues are created', interarrival: { type: 'exponential', mean: 1 / rate }, limit: null },
      ...(pickup ? [{ id: 'pickup', kind: 'delay', name: 'Waiting to be picked up', duration: { type: 'constant', value: pickupDays } }] : []),
      { id: 'work', kind: 'server', name: 'Issues are worked on', capacity, service },
      { id: 'done', kind: 'sink', name: 'Issues are resolved' },
    ],
    connections: pickup
      ? [
          { id: 'f1', from: 'arrive', to: 'pickup' },
          { id: 'f2', from: 'pickup', to: 'work' },
          { id: 'f3', from: 'work', to: 'done' },
        ]
      : [
          { id: 'f1', from: 'arrive', to: 'work' },
          { id: 'f2', from: 'work', to: 'done' },
        ],
    experiment: { time_unit: 'day', warmup: 30, duration: 365, replications: 16, seed: 2026 },
  };
}

// Offered load / target utilisation, rounded up: the people needed to run at about 70 percent.
export function defaultCapacity(arrivalPerDay, serviceMean, target = 0.7) {
  return Math.max(1, Math.ceil((arrivalPerDay * serviceMean) / target));
}

// Run the model with the WASI build of stochcraft-cli. stdout goes to a file, so the JSON lines can be read back.
export async function runModel(wasmBytes, model, replications, timing) {
  const T0 = Date.now(); const lap = (k) => { if (timing) timing[k] = Date.now() - T0; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  const script = [
    { command: 'model.set', params: { model } },
    { command: 'run', params: replications ? { replications } : {} },
  ];
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
  const outPath = path.join(dir, 'stdout.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(path.join(dir, 'stderr.txt'), 'w');
  try {
    const wasi = new WASI({
      version: 'preview1',
      args: ['stochcraft-cli', 'exec', '/work/script.json'],
      preopens: { '/work': dir },
      stdout: outFd,
      stderr: errFd,
      returnOnExit: true,
    });
    // a WebAssembly.Module passed in is reused: compiling the 4.8 MB program takes 0.2 to 0.5 s each time
    const mod = wasmBytes instanceof WebAssembly.Module ? wasmBytes : await WebAssembly.compile(wasmBytes); lap('compile');
    const instance = await WebAssembly.instantiate(mod, wasi.getImportObject()); lap('instantiate');
    const exit = wasi.start(instance); lap('run');
    const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const err = fs.readFileSync(path.join(dir, 'stderr.txt'), 'utf8').slice(0, 300);
    const last = lines[lines.length - 1];
    if (exit !== 0 || !last || last.error) throw new Error(`stochcraft-cli exit ${exit}: ${JSON.stringify(last?.error ?? last ?? err).slice(0, 300)}`);
    return last.result;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
