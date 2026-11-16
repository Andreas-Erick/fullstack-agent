// Settings in tabs (pure, test/settingstabs.test.js): which card belongs to which tab, and the search
// that looks across all of them. The screen held 19 cards in one long grid; a tab shows one group.
// A new card (settings.js card(id, …)) goes into a tab here, or the test fails.

export const TABS = [
  { id: 'persona', label: 'Persona & look', cards: ['agent', 'ui', 'world'] },
  { id: 'brain', label: 'Brain', cards: ['brain', 'extensions'] },
  { id: 'voice', label: 'Voice', cards: ['voice', 'stt'] },
  { id: 'knowledge', label: 'Knowledge', cards: ['obsidian', 'calendar', 'learning', 'data', 'documents'] },
  { id: 'connections', label: 'Connections', cards: ['web', 'github', 'remote'] },
  { id: 'safety', label: 'Safety', cards: ['safety', 'code'] },
  { id: 'system', label: 'System', cards: ['health', 'helperapps'] },
];

/** The tab a card is in; a card no tab names shows in the last one rather than nowhere. */
export function tabFor(cardId) {
  return (TABS.find((t) => t.cards.includes(cardId)) || TABS[TABS.length - 1]).id;
}

/** A known tab id, else the first. */
export const validTab = (id) => (TABS.some((t) => t.id === id) ? id : TABS[0].id);

/** The tab after/before `id` (arrow keys), wrapping around. */
export function stepTab(id, dir) {
  const i = TABS.findIndex((t) => t.id === id);
  return TABS[(Math.max(0, i) + dir + TABS.length) % TABS.length].id;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

/** Whether a card's text (title, descriptions, labels) matches a search: every word, anywhere. */
export function matches(text, query) {
  const words = norm(query).trim().split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = norm(text);
  return words.every((w) => hay.includes(w));
}
