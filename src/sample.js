// Sample data for a site with no Jira history to learn from: a made-up team of about five people, so that someone trying
// the app on an empty site can still see every part of it. The numbers are generated here with a fixed seed; nothing is
// read from Jira, and the result says so (`flow.sample`).

export function sampleFlow(stats) {
  let seed = 20261121;
  const u = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 1) / 4294967297; };
  const norm = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  const n = 240, days = 240;
  const queue = [], service = [], lead = [];
  for (let i = 0; i < n; i++) {
    const q = -0.3 * Math.log(u());            // waits about 0.3 days before someone starts
    const w = Math.exp(-0.99 + 0.77 * norm()); // works for about 0.5 days, log-normal
    queue.push(q); service.push(w); lead.push(q + w);
  }
  const arrivals = 6 * days, resolved = Math.round(arrivals * 0.99);
  return {
    project: 'SAMPLE', sample: true, from: '', to: '', days, sampled: n,
    arrivals, resolved, arrivalPerDay: arrivals / days, throughputPerDay: resolved / days,
    queueDays: stats(queue), serviceDays: stats(service), leadDays: stats(lead), serviceSample: service,
    summary: `Sample data (a made-up team, not read from Jira): ${arrivals} created (6.00/day), ${resolved} resolved over ${days} days.`,
  };
}
