// The chart engine lives in renderer/js/chartcore.mjs, shared with the document viewer, which redraws a
// chart live while the user moves its parameters (renderer/js/livedoc.js). An .mjs file is an ES module
// everywhere, and Node (24, as in Electron 45) can require() one.
module.exports = require('../renderer/js/chartcore.mjs');
