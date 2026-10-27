// Agent tools: Web search and pages (websearch.js); results are external content.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const websearch = require('../websearch');
const { obj, str, int } = require('./common');

module.exports = [
  {
    name: 'web_search',
    group: 'web',
    description: 'Search the internet. Returns titles, URLs and snippets. Use for current events, facts you are unsure about, prices, docs, anything recent. Follow up with web_fetch to read a page.',
    parameters: obj({ query: str('Search query'), limit: int('Max results (default 6)') }, ['query']),
    untrusted: true,
    run: async (a) => websearch.search(a.query, a.limit),
  },
  {
    name: 'web_fetch',
    group: 'web',
    description: 'Fetch a web page and return its readable text (Markdown-ish). Use on URLs from web_search results or that the user gives you. Cite the URL when you use the content.',
    parameters: obj({ url: str('http(s) URL') }, ['url']),
    untrusted: true,
    run: async (a) => websearch.fetchPage(a.url),
  },
];
