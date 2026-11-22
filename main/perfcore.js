// Performance profiles live in renderer/js/perfcore.mjs, shared with the window (js/perfcore.js): the one
// profile() rule, the Claude session cap and idle time (claudecode.js), and the window's limits.
// An .mjs file is an ES module everywhere, and Node (24, as in Electron 45) can require() one.
module.exports = require('../renderer/js/perfcore.mjs');
