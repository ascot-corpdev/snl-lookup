// Splits the test suites into parts, so GitHub can run the parts at the same time on separate machines.
//   npm test -- --shard=2/4     the second of four parts
// Every suite lands in exactly one part, and the same files always give the same parts. Suites are shared out by
// how long each took when last timed (tests/durations.json, seconds; written by `npm test -- --timings`), longest
// first, each to the part with the least so far, so the parts take about as long as each other. A suite that has
// never been timed is given a time from its size; a browser suite counts for more than its size because it also
// starts Chromium. Timings that have gone stale only make the parts less even: they never lose a suite.

/** How much a suite of each kind weighs for its size, when it has no timing. */
export const KIND_WEIGHT = { web: 2.5, functions: 1, scripts: 1, worker: 1 };
/** Bytes of test file to one second, for a suite with no timing (a rough figure from the timed suites). */
export const BYTES_PER_SECOND = 9000;

/** "--shard=2/4" as {index: 2, total: 4}; null when the argument isn't a shard; throws with plain words when it is
    one but can't be used. */
export function parseShard(arg) {
  const m = /^--shard(?:=(.*))?$/.exec(String(arg));
  if (!m) return null;
  const parts = /^(\d+)\/(\d+)$/.exec(m[1] ?? "");
  const index = parts ? Number(parts[1]) : NaN, total = parts ? Number(parts[2]) : NaN;
  if (!parts || !(total >= 1 && total <= 16) || !(index >= 1 && index <= total)) {
    throw new Error(`Can't use ${arg}. Write it as --shard=2/4: the part to run, a slash, then how many parts there are (1 to 16).`);
  }
  return { index, total };
}

/** The seconds a suite is expected to take: its last timing, or a figure from its size. */
export function expectedSeconds(s, durations = {}) {
  const timed = Number(durations?.[s.name]);
  if (Number.isFinite(timed) && timed > 0) return timed;
  return Math.max(1, (Math.max(0, Number(s.size) || 0) * (KIND_WEIGHT[s.kind] ?? 1)) / BYTES_PER_SECOND);
}

/** The suites of each part: a list of `total` lists of names. suites: [{name, kind, size}]; durations: {name: seconds}. */
export function planShards(suites, total, durations = {}) {
  const parts = Array.from({ length: total }, () => ({ load: 0, names: [] }));
  const ordered = [...suites].map((s) => ({ name: s.name, w: expectedSeconds(s, durations) })).sort((a, b) => b.w - a.w || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const s of ordered) {
    let least = parts[0];
    for (const p of parts) if (p.load < least.load) least = p;
    least.load += s.w;
    least.names.push(s.name);
  }
  return parts.map((p) => p.names.sort());
}
