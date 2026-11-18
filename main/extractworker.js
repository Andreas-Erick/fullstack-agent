// Text extraction for a file dropped into the chat (main/attachments.js), in its own thread: a crafted PDF
// or Word file can't block the main process. Its heap is capped; what it unpacks lives outside the heap, in
// the app's own memory, so main/attachments.js watches the process's growth and ends the thread.
const { parentPort } = require('worker_threads');
if (parentPort) {
  parentPort.once('message', async ({ bytes, kind, maxChars }) => {
    try {
      parentPort.postMessage({ ok: true, ...(await require('./doctext').textOf(Buffer.from(bytes), kind, { maxChars })) });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: String(err?.message || err).slice(0, 200) });
    }
  });
}
