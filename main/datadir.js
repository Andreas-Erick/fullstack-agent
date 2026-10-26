// Where the app keeps its data (<appData>/Siren Assistant). Required first by main.js, before any
// module asks Electron for the userData path.
// - NEXUS_USER_DATA overrides it (portable installs, testing); NEXUS_DOCUMENTS likewise the Documents
//   folder (where the default vault and exports go), so test runs never touch the user's own.
// - The folder of the app's former name (Nexus Agent) moves to the new one on the first start after the
//   update: settings, keys, conversations, faces, skills all come along. If it can't be moved (in use,
//   permissions), the app keeps using it where it is.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LEGACY_NAME = 'Nexus Agent';

/** The decision, pure: { use } keeps a folder in place, { move: [from, to] } renames it first. */
function plan({ override, current, legacy, exists }) {
  if (override) return { use: path.resolve(override) };
  if (current === legacy || exists(current) || !exists(legacy)) return {};
  return { move: [legacy, current] };
}

function setup() {
  if (process.env.NEXUS_DOCUMENTS) app.setPath('documents', path.resolve(process.env.NEXUS_DOCUMENTS));
  const current = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), LEGACY_NAME);
  const p = plan({ override: process.env.NEXUS_USER_DATA, current, legacy, exists: fs.existsSync });
  if (p.use) return app.setPath('userData', p.use);
  if (!p.move) return;
  try {
    fs.renameSync(...p.move);
  } catch {
    app.setPath('userData', legacy);
  }
}

/** A folder in Documents named for the app (exports); the one from before the rename if it exists. */
function documentsFolder(name, legacyName) {
  const legacy = path.join(app.getPath('documents'), legacyName);
  return fs.existsSync(legacy) ? legacy : path.join(app.getPath('documents'), name);
}

const exportsFolder = () => documentsFolder('Siren Exports', 'Nexus Exports');

module.exports = { setup, plan, documentsFolder, exportsFolder, LEGACY_NAME };
