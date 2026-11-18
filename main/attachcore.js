// The rules for files in the chat live in renderer/js/attachcore.mjs, shared with the window (js/attach.js,
// js/chat.js). An .mjs file is an ES module everywhere, and Node (24, as in Electron 45) can require() one.
module.exports = require('../renderer/js/attachcore.mjs');
