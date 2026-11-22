// The built-in faces live in renderer/js/faces/registry.mjs, shared with the desktop window and the phone
// client. An .mjs file is an ES module everywhere, and Node (24, as in Electron 45) can require() one.
module.exports = require('../renderer/js/faces/registry.mjs');
