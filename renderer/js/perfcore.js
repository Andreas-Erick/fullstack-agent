// The window's door to the performance rules: they live in perfcore.mjs, shared with the main process
// (main/perfcore.js), so the window and main can never disagree on the profile. Imports stay './perfcore.js'.
export * from './perfcore.mjs';
