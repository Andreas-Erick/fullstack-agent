// Where a window of the app may go (main.js guardNavigation). The app's pages never navigate themselves
// (they load with loadURL), so a will-navigate to another app:// page is a link in content, a relative
// [x](Notes/a.md), which replaced the whole window with "Not found"; [x](?q) would reload the whole app.
// Only the page itself (a reload) stays; web links open in the browser. Pure (test/securityreview.test.js).

/** 'allow' (the page itself), 'external' (an http(s) link: the browser) or 'block'. */
function navDecision(currentUrl, url) {
  let to;
  try {
    to = new URL(url);
  } catch {
    return 'block';
  }
  if (to.protocol === 'http:' || to.protocol === 'https:') return 'external';
  if (to.protocol !== 'app:') return 'block';
  try {
    const from = new URL(currentUrl);
    // The hash isn't compared: a hash change is an in-page navigation, which never fires will-navigate.
    return from.protocol === 'app:' && from.host === to.host && from.pathname === to.pathname && from.search === to.search ? 'allow' : 'block';
  } catch {
    return 'block';
  }
}

module.exports = { navDecision };
