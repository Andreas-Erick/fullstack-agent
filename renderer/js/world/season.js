// The Inner World's season (pure: no DOM; tested in test/worldmap.test.js). It follows the real date,
// on the user's half of the world (guessed from the time zone), unless the user picked one.

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

// Time zones south of the equator (the common ones; everything else counts as north).
const SOUTH = /^(Australia\/|Antarctica\/|Pacific\/(Auckland|Chatham|Fiji|Tongatapu|Apia|Noumea|Efate)|America\/(Argentina|Santiago|Sao_Paulo|Montevideo|Asuncion|La_Paz|Lima|Punta_Arenas|Bahia|Recife|Fortaleza|Belem|Maceio|Cuiaba|Campo_Grande|Porto_Velho)|Africa\/(Johannesburg|Maputo|Harare|Lusaka|Windhoek|Gaborone|Maseru|Mbabane|Antananarivo|Lubumbashi|Luanda|Blantyre|Dar_es_Salaam)|Indian\/(Mauritius|Reunion|Antananarivo))/;

export const southern = (timeZone) => SOUTH.test(String(timeZone || ''));

/** 'spring' | 'summer' | 'autumn' | 'winter' for a date. choice: 'auto' (follow the date) or a season. */
export function seasonOf(date = new Date(), { choice = 'auto', timeZone = '' } = {}) {
  if (SEASONS.includes(choice)) return choice;
  const m = date.getMonth(); // 0 = January
  const north = m <= 1 || m === 11 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
  if (!southern(timeZone)) return north;
  return { winter: 'summer', spring: 'autumn', summer: 'winter', autumn: 'spring' }[north];
}
