// Turns whatever ClubLocker's page loads into a clean list of tournaments.
// ClubLocker has no public feed, so this looks for lists of "things with a name
// and a start date" in the data the page downloads, and falls back to reading
// the page itself.

const NAME_KEYS  = ['name', 'title', 'tournamentname', 'tournament_name', 'eventname', 'event_name'];
const START_KEYS = ['startdate', 'start_date', 'startsat', 'starts_at', 'startdatetime', 'start_time', 'starttime',
                    'begindate', 'begin_date', 'datestart', 'date_start', 'start', 'from', 'date'];
const END_KEYS   = ['enddate', 'end_date', 'endsat', 'ends_at', 'enddatetime', 'end_time', 'endtime',
                    'finishdate', 'dateend', 'date_end', 'end', 'to'];
const ID_KEYS    = ['id', 'tournamentid', 'tournament_id', '_id'];
const LEVEL_KEYS = ['category', 'level', 'type', 'tournamenttype', 'tournament_type', 'division', 'divisionname'];
const VENUE_KEYS = ['venue', 'venuename', 'location', 'locationname', 'facility', 'facilityname', 'club', 'clubname', 'host'];
const CITY_KEYS  = ['city', 'locationcity'];
const STATE_KEYS = ['state', 'statecode', 'state_code', 'region', 'province'];

const pad = n => String(n).padStart(2, '0');
const laDate = d => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(d);

export const todayLA = () => laDate(new Date());

const lowerKeys = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
const pick = (lo, keys) => { for (const k of keys) if (lo[k] != null && lo[k] !== '') return lo[k]; return undefined; };

function text(v){
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object'){
    const lo = lowerKeys(v);
    return text(pick(lo, ['name', 'title', 'label', 'displayname']));
  }
  return '';
}

export function toYMD(v){
  if (v == null || v === '') return null;
  if (typeof v === 'number'){ return laDate(new Date(v < 1e11 ? v * 1000 : v)); }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?$)/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  const d = new Date(s);
  return isNaN(d) ? null : laDate(d);
}

export function normalizeRecord(o){
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const lo = lowerKeys(o);
  const name = text(pick(lo, NAME_KEYS));
  const start = toYMD(pick(lo, START_KEYS));
  if (!name || !start) return null;
  let end = toYMD(pick(lo, END_KEYS)) || start;
  if (end < start) end = start;

  const loc = pick(lo, VENUE_KEYS);
  const locLo = loc && typeof loc === 'object' ? lowerKeys(loc) : {};
  const id = pick(lo, ID_KEYS);
  const level = text(pick(lo, LEVEL_KEYS));
  const rawUrl = text(pick(lo, ['url', 'link', 'website']));

  return {
    name,
    start,
    end,
    venue: text(loc),
    city: text(pick(lo, CITY_KEYS)) || text(pick(locLo, CITY_KEYS)),
    state: text(pick(lo, STATE_KEYS)) || text(pick(locLo, STATE_KEYS)),
    level: level && level.length <= 30 ? level : '',
    url: id != null && /^[\w-]+$/.test(String(id)) ? `https://clublocker.com/tournaments/${id}`
        : /^https?:\/\//.test(rawUrl) ? rawUrl : ''
  };
}

// Walk any JSON and collect every array that looks like a list of tournaments.
export function findTournaments(json){
  const found = [];
  let sawList = false;
  (function walk(node){
    if (Array.isArray(node)){
      const objs = node.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length){
        const recs = objs.map(normalizeRecord).filter(Boolean);
        if (recs.length >= Math.max(1, objs.length * 0.5)){ sawList = true; found.push(...recs); }
      }
      node.forEach(walk);
    } else if (node && typeof node === 'object'){
      Object.values(node).forEach(walk);
    }
  })(json);
  return { records: found, sawList };
}

// Keep upcoming California events, remove duplicates, sort by date.
export function cleanUp(records, today = todayLA()){
  const seen = new Set();
  return records
    .filter(r => !r.state || /^(CA|California)$/i.test(r.state))
    .filter(r => r.end >= today)
    .filter(r => { const k = (r.url || r.name.toLowerCase()) + '|' + r.start; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name))
    .map(({ state, ...r }) => Object.fromEntries(Object.entries(r).filter(([, v]) => v)));
}

// ---- fallback: read dates out of text shown on the page ----
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
export function datesFromText(t){
  let m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:\s*[-–]\s*(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+)?(\d{1,2}))?,?\s+(\d{4})\b/i.exec(t);
  if (m){
    const y = +m[5], m1 = MONTHS[m[1].toLowerCase()], d1 = +m[2];
    const m2 = m[3] ? MONTHS[m[3].toLowerCase()] : m1, d2 = m[4] ? +m[4] : d1;
    return [`${y}-${pad(m1)}-${pad(d1)}`, `${y}-${pad(m2)}-${pad(d2)}`];
  }
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*[-–]\s*(\d{1,2})\/(\d{1,2})\/(\d{4}))?/.exec(t);
  if (m){
    const a = `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
    return [a, m[4] ? `${m[6]}-${pad(m[4])}-${pad(m[5])}` : a];
  }
  return null;
}
