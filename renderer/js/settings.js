// The Settings view lives in settings/ (index.js draws it; one module per group of cards). This file keeps
// the names other modules import from it (app.js, onboarding.js, setup.js).
export { initSettings } from './settings/index.js';
export { showResult, showFailure } from './settings/fields.js';
export { shrinkImage } from './settings/persona.js';
export { connectClaude, testOutcome, localFinder } from './settings/brain.js';
