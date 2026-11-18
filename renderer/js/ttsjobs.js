// The offline voice's sentence jobs (voice.js localVoice, tts-worker.js): which wait, which one is
// being made, which have taken too long, and which a stop cancels. A job is posted at once, even while
// the model still loads; the run limit counts from its `begin`, so a long reply's later sentences,
// queued behind the earlier ones, no longer time out while they wait. Pure: test/ttsjobs.test.js.

export function createJobs({ runLimitMs = 30000 } = {}) {
  const jobs = new Map(); // id → { postedAt, keep, waitMs, begunAt }
  let overSince = null; // a run went past the limit, and the worker has said nothing since

  return {
    // waitMs: how long it may wait for the model to load (it gives up while that still downloads).
    post(id, { now, keep = false, waitMs = Infinity }) {
      jobs.set(id, { postedAt: now, keep, waitMs, begunAt: null });
    },
    begin(id, now) {
      const job = jobs.get(id);
      if (job) job.begunAt = now;
    },
    done(id) {
      jobs.delete(id);
    },
    /** Any message from the worker about a job: it is alive. */
    heard() {
      overSince = null;
    },
    /** Jobs that ran past the limit, or waited past their waitMs for a model that hasn't loaded. */
    expired(now, { loaded }) {
      const out = [];
      for (const [id, job] of jobs) {
        const ran = job.begunAt !== null && now - job.begunAt > runLimitMs;
        if (ran) overSince ??= now;
        if (ran || (job.begunAt === null && !loaded && now - job.postedAt > job.waitMs)) out.push(id);
      }
      return out;
    },
    /**
     * A run went over and the worker stayed silent for another limit: it hangs, and what waits behind
     * it never begins. A merely slow run (a long sentence on a slow processor) reports back meanwhile.
     */
    stalled(now) {
      return overSince !== null && now - overSince > runLimitMs;
    },
    /** A stop: removes and returns the jobs up to `upTo` that haven't begun (keep ones stay). */
    cancel(upTo) {
      const out = [];
      for (const [id, job] of jobs) {
        if (id <= upTo && job.begunAt === null && !job.keep) out.push(id);
      }
      for (const id of out) jobs.delete(id);
      return out;
    },
    get size() {
      return jobs.size;
    },
  };
}
