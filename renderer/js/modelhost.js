// One in-window model host: a Web Worker that loads an ML model (the offline voice, the voice detector,
// speech-to-text in voice.js). It owns what the three had each written for themselves: load once and
// await the same load, the idle unload by performance profile, the restart of a worker that hangs, and
// the failure cool-down. The adapter keeps its protocol (what it posts, what the messages mean).
// Pure: the Worker factory, the clock, the profile and the log are passed in (test/modelhost.test.js).

const browserClock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

/**
 * create(): a Worker-like { postMessage, terminate, onmessage, onerror }.
 * configure(worker, key): posts the load message; after gate() resolves when there is one (perfReady:
 *   the profile decides GPU or not only after the hardware check), else at once, before any later post.
 * onStart(worker): a worker was just created. onMessage(msg): a message from the current worker.
 * onStop(reason, kind): the worker went; kind 'failed' (an error), 'unloaded' (asked), 'idle', 'stuck'
 *   (restart) or 'switched' (load with another key). Whatever waited on it fails with `reason` here.
 * idleMs(profile): how long the model stays loaded after idle() (0 = until asked); idleLog/idleReason.
 * retryAfterMs: after a failure, load() returns the failure for this long (a failed download isn't
 *   retried on every sentence). switchReason: why the old worker went when the key changed.
 */
export function createModelHost({
  name = 'model',
  create,
  configure = () => {},
  gate = null,
  onStart = () => {},
  onMessage = () => {},
  onStop = () => {},
  failText = `the ${name} failed to load`,
  idleMs = () => 0,
  profile = () => '',
  idleLog = '',
  idleReason = `the ${name} was unloaded`,
  retryAfterMs = 0,
  switchReason = `the ${name} was switched`,
  clock = browserClock,
  log = () => {},
} = {}) {
  let worker = null;
  let key = '';
  let loaded = false;
  let promise = null; // the load: resolves on ready(), rejects when the worker goes first
  let settle = null;
  let cooling = false;
  let idleTimer = 0;

  const clearIdle = () => {
    clock.clearTimeout(idleTimer);
    idleTimer = 0;
  };

  // The worker goes; returns the load's settle functions (for the caller to reject after onStop).
  function drop() {
    const w = worker;
    const s = settle;
    worker = null;
    key = '';
    loaded = false;
    settle = null;
    clearIdle();
    w?.terminate();
    return s;
  }

  const host = {
    get worker() {
      return worker;
    },
    get loaded() {
      return loaded;
    },
    get key() {
      return key;
    },
    get cooling() {
      return cooling;
    },

    /** Loads the model (once; a load already running or done is shared), for `k` (another key: a new worker). */
    load(k = '') {
      if (worker && k === key) return promise;
      if (!worker && cooling) return promise; // a failed load: its reason, until the retry
      if (worker) host.unload(switchReason, 'switched');
      const w = create();
      worker = w;
      key = k;
      loaded = false;
      promise = new Promise((resolve, reject) => (settle = { resolve, reject }));
      promise.catch(() => {}); // callers await promise themselves; this keeps an unawaited failure from being unhandled
      w.onmessage = (e) => worker === w && onMessage(e.data);
      w.onerror = (e) => worker === w && host.fail(e?.message || failText);
      onStart(w);
      const wait = gate?.();
      if (wait) wait.then(() => worker === w && configure(w, k), () => {});
      else configure(w, k);
      return promise;
    },

    /** The adapter heard the worker's ready message. */
    ready() {
      loaded = true;
      settle?.resolve();
    },

    /** In use: no idle unload until idle() is called again. */
    use() {
      clearIdle();
    },

    /** Starts (or restarts) the idle clock: after idleMs(profile) the model goes; nothing when 0. */
    idle() {
      clearIdle();
      const ms = idleMs(profile());
      if (!(ms > 0)) return;
      idleTimer = clock.setTimeout(() => {
        idleTimer = 0;
        if (!worker) return;
        if (idleLog) log('info', idleLog);
        host.unload(idleReason, 'idle');
      }, ms);
    },

    /** Frees the model (asked, or idle). Whatever waited fails with `reason`. False if none was loaded. */
    unload(reason = idleReason, kind = 'unloaded') {
      clearIdle();
      if (!worker) return false;
      const s = drop();
      promise = null;
      onStop(reason, kind);
      s?.reject(new Error(reason));
      return true;
    },

    /** The worker failed (an error message or event). With retryAfterMs, load() returns the failure meanwhile. */
    fail(reason = failText) {
      const s = drop();
      onStop(reason, 'failed');
      s?.reject(new Error(reason));
      if (!retryAfterMs) return void (promise = null);
      cooling = true;
      promise = Promise.reject(new Error(reason));
      promise.catch(() => {}); // callers await promise themselves; this keeps an unawaited failure from being unhandled
      clock.setTimeout(() => {
        cooling = false;
        if (!worker) promise = null;
      }, retryAfterMs);
    },

    /** A worker that hangs: logged as `warn` (with `data`), then unloaded; the next load starts afresh. */
    restart(reason, { warn = `${name} stopped responding; restarting it`, data } = {}) {
      log('warn', warn, data);
      return host.unload(reason, 'stuck');
    },

    /** restart() unless the returned cancel runs within `ms` (0: no limit), for this worker only. */
    deadline(ms, opts) {
      if (!(ms > 0)) return () => {};
      const w = worker;
      const t = clock.setTimeout(() => worker === w && host.restart(opts?.reason, opts), ms);
      return () => clock.clearTimeout(t);
    },
  };
  return host;
}
