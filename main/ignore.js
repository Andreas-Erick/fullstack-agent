// A failure that is safe to drop, said out loud: `p.catch(ignore('why it is safe'))`. It writes a DEBUG
// line (only with Detailed logging on), so a dropped error can still be found when something looks wrong,
// and yields `value`, the fallback the caller reads instead (`ignore('no cache yet', null)`).
// A failure the user or the log should know about is a log.warn, never this (docs/ENGINEERING.md §2).
const log = require('./logger');

function ignore(reason, value) {
  return (err) => {
    log.debug?.('ignored', { reason, error: err });
    return value;
  };
}

module.exports = { ignore };
