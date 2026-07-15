const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { parse: parseCsvSync } = require('csv-parse/sync');
try { require('dotenv').config(); } catch (e) { /* dotenv is optional locally; hosting platforms set env vars directly */ }
const { connectDB, getDB } = require('./db');
const { seedAdminIfNeeded, sessionMiddleware, requireAuth, requireAdmin, authRoutes } = require('./auth');

const app = express();
const PORT = process.env.PORT || 4100;

// Render sits behind a proxy that terminates TLS — without this, secure
// cookies (used in production, see auth.js) would never get set and every
// login would silently fail to persist.
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(sessionMiddleware());
app.use('/api/auth', authRoutes());

// Static files are served to everyone (the login screen itself lives here),
// but every /api/* route below is gated: GET/read routes require any logged
// in user, write routes require the admin role specifically.
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ── Config — edit these two lists as your process evolves ──────
// Reason for Missed -> which vertical report it counts toward.
// Add new reasons here any time; the dropdown and reports pick them up automatically.
const REASON_VERTICAL_MAP = {
  'EC chat':              'EC',
  'No EC tech':           'EC',
  'Tool issue':           'EC',
  'UEMS meeting':         'EC',
  'EC meeting':           'EC',
  'No MSP Central Tech':  'MSP Central',
  'Security chat':        'Security',
  'MDM Chat':             'MDM',
  'Customer':             'Customer'
};
const REASON_OPTIONS = Object.keys(REASON_VERTICAL_MAP);
const VERTICALS = [...new Set(Object.values(REASON_VERTICAL_MAP))]; // ['EC','MSP Central','Security','MDM','Customer']

function verticalForReason(reason) {
  return REASON_VERTICAL_MAP[reason] || null; // unfilled/unknown reason = not yet counted in any vertical
}

const TIME_RANGE_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const from = String(h).padStart(2, '0') + ':00';
  const to = String((h + 1) % 24).padStart(2, '0') + ':00';
  return `${from} - ${to}`;
});
function timeRangeForHour(h) {
  return TIME_RANGE_OPTIONS[h] || '';
}

function formatWeekRangeLabel(weekStartingDateStr) {
  const start = new Date(weekStartingDateStr + 'T00:00:00Z');
  const end = new Date(start.getTime() + 6 * 86400000);
  const fmt = d => `${String(d.getUTCDate()).padStart(2, '0')} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
  return `${fmt(start)} - ${fmt(end)} ${end.getUTCFullYear()}`;
}
function monthLabelFor(yyyymm) {
  const [y, m] = yyyymm.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' });
}

// ── Storage layer (MongoDB) ────────────────────────────────────
// Every record is one document in the "records" collection, with a `yyyymm`
// field (e.g. "2026-07") standing in for what used to be "which file is it
// in". These helpers keep the exact same shapes/names the rest of the file
// already expects (readAllRecords() -> array with _yyyymm, readMonth() ->
// {records: [...]}), so none of the route logic below had to change.
function recordsCol() { return getDB().collection('records'); }

async function readAllRecords() {
  const docs = await recordsCol().find({}, { projection: { _id: 0 } }).toArray();
  return docs.map(r => ({ ...r, _yyyymm: r.yyyymm }));
}
async function readMonth(yyyymm) {
  const docs = await recordsCol().find({ yyyymm }, { projection: { _id: 0 } }).toArray();
  return { records: docs };
}
function isValidMonth(yyyymm) { return /^\d{4}-\d{2}$/.test(yyyymm); }
function genId() { return 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

// A visitor/chat id should only ever exist once, globally — checked in one
// query against every incoming id at once (rather than one query per row)
// so a large weekly CSV doesn't turn into hundreds of round-trips to Atlas.
async function existingVisitorIds(visitorIds) {
  const docs = await recordsCol().find({ visitorId: { $in: [...new Set(visitorIds)] } }, { projection: { visitorId: 1 } }).toArray();
  return new Set(docs.map(d => d.visitorId));
}

// Label each record's own week among the distinct WeekStartingDate values
// seen so far in that month, in ascending order — 1st Week, 2nd Week, etc.
// This mirrors your sheet's grouping and relies on the CSV's own
// WeekStartingDate column rather than guessing a day-of-month formula.
function assignWeekLabels(records) {
  const starts = [...new Set(records.map(r => r.weekStartingDate).filter(Boolean))].sort();
  const labelByStart = {};
  starts.forEach((s, i) => { labelByStart[s] = ordinal(i + 1) + ' Week'; });
  return records.map(r => ({ ...r, weekLabel: r.weekLabelOverride || labelByStart[r.weekStartingDate] || 'Unknown Week' }));
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Parses timestamps like "01 Jul, 2026 00:15:06" or "01 Jul 2026, 00:15:06"
// WITHOUT ever consulting the server process's own OS timezone. Plain
// `new Date("01 Jul, 2026 00:15:06")` is ambiguous per spec — engines fall
// back to parsing it as *local* time and then convert to UTC, which means
// the exact same CSV imports differently depending on where the app happens
// to be hosted (e.g. a server set to IST silently shifts every timestamp
// back by 5:30). Here we pull the literal Y/M/D/H/M/S out of the string with
// a regex and pin them down with Date.UTC, so "01 Jul, 2026 00:15:06" in the
// CSV always becomes exactly 01 Jul 2026 00:15:06 in the app, everywhere.
const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseChatDate(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTH_ABBR[m[2].slice(0, 3).toLowerCase()];
    const year = parseInt(m[3], 10);
    const hour = parseInt(m[4], 10);
    const minute = parseInt(m[5], 10);
    const second = m[6] ? parseInt(m[6], 10) : 0;
    if (month !== undefined) return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
  // A plain "YYYY-MM-DD" (no time) is unambiguous and safe to hand to the
  // built-in parser — the spec requires engines to treat date-only ISO
  // strings as UTC, so there's no local-timezone risk here.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw).trim())) {
    const d = new Date(raw + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : d;
  }
  // Last resort for any other/unexpected format — better than silently
  // dropping the row, but flagged so it's easy to spot in server logs.
  const fallback = new Date(raw);
  if (!isNaN(fallback.getTime())) console.warn(`[import] Date "${raw}" didn't match the expected format — parsed with the system default, which may be timezone-sensitive.`);
  return isNaN(fallback.getTime()) ? null : fallback;
}

// ── CSV import ───────────────────────────────────────────────
// Supports two shapes of CSV:
//  1) The raw weekly Zoho export (69 columns — only these matter)
//  2) Your own already-completed report format (Visitor ID, Missed By,
//     Reason for Missed, Time Range already filled in) — useful for
//     bringing in historical months. Each field lists every column
//     name seen in either format; the first match found in the file wins.
const COLUMN_ALIASES = {
  visitorId:        ['Visitor Id', 'Visitor ID'],
  department:       ['Department'],
  attender:         ['Attender Name', 'Attender'],
  chatTime:         ['Chat Intiated Time', 'Date'],
  country:          ['Country Code', 'Country'],
  weekStartingDate: ['WeekStartingDate', 'Week Starting Date'],
  missedBy:         ['Missed By'],
  reasonForMissed:  ['Reason for Missed'],
  timeRange:        ['Time Range']
};
// visitorId/department/attender/chatTime/country are required — a file
// must have at least one alias for each of those. The rest are optional.
const REQUIRED_FIELDS = ['visitorId', 'department', 'attender', 'chatTime', 'country'];

// The last Sunday on/before the given date, as YYYY-MM-DD — used only
// when a CSV doesn't supply its own WeekStartingDate column.
function computeWeekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // getUTCDay(): Sun=0
  return d.toISOString().slice(0, 10);
}

// Recognizing any of these words/phrases as column headers lets us find a
// header row wherever it appears in the file, rather than assuming row 1.
const HEADER_MARKERS = [
  'Sl.No', 'Visitor Id', 'Visitor ID', 'Department', 'Missed By', 'Attender',
  'Attender Name', 'Date', 'Chat Intiated Time', 'Country', 'Country Code',
  'Time Range', 'Reason for Missed', 'WeekStartingDate', 'Week Starting Date'
];

// Handles three shapes of CSV in one pass:
//  1) A plain single-header table (the raw Zoho export, or your own
//     completed-report format).
//  2) A "sectioned" export like this one — week-label rows ("1st Week"),
//     blank separator rows, and a repeated header row before each week's
//     block — exactly how the sheet looks when exported as-is.
// Returns an array of row objects keyed by whatever header text preceded them,
// the same shape parseCsvSync's {columns:true} would have produced for a
// plain file — so everything downstream (COLUMN_ALIASES etc.) is unchanged.
function parseFlexibleCsv(buffer) {
  const rawRows = parseCsvSync(buffer, { columns: false, skip_empty_lines: false, bom: true, relax_column_count: true });
  let currentHeader = null;
  let currentSectionLabel = null; // e.g. "1st Week", if the file has its own section labels
  const records = [];

  rawRows.forEach(cells => {
    const trimmed = cells.map(c => String(c || '').trim());
    const nonEmptyCount = trimmed.filter(Boolean).length;
    if (nonEmptyCount === 0) return; // blank separator row

    const markerHits = trimmed.filter(c => HEADER_MARKERS.includes(c)).length;
    if (markerHits >= 2) { currentHeader = trimmed; return; } // this row IS a header for what follows

    if (nonEmptyCount === 1) {
      // A single populated cell between sections, e.g. "1st Week" / "2nd Week" —
      // remember it so rows in this section carry the file's own week grouping.
      if (/week/i.test(trimmed.find(Boolean) || '')) currentSectionLabel = trimmed.find(Boolean);
      return;
    }
    if (!currentHeader) return; // stray data before any header was found — can't map columns

    const rowObj = {};
    currentHeader.forEach((colName, i) => { if (colName) rowObj[colName] = cells[i] !== undefined ? cells[i] : ''; });
    if (currentSectionLabel) rowObj._sectionWeekLabel = currentSectionLabel;
    records.push(rowObj);
  });

  return records;
}

app.post('/api/upload', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  let rows;
  try {
    rows = parseFlexibleCsv(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Could not parse this CSV: ' + e.message });
  }
  if (!rows.length) return res.status(400).json({ success: false, message: 'This CSV has no data rows we could recognize.' });

  const allKeys = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
  const colFor = {};
  Object.entries(COLUMN_ALIASES).forEach(([field, aliases]) => { colFor[field] = aliases.find(a => allKeys.has(a)) || null; });

  const missingRequired = REQUIRED_FIELDS.filter(f => !colFor[f]);
  if (missingRequired.length) {
    const wanted = missingRequired.map(f => COLUMN_ALIASES[f].join(' / ')).join(', ');
    return res.status(400).json({ success: false, message: `This CSV is missing expected column(s): ${wanted}` });
  }

  // One round-trip to find out which of this file's visitor ids already
  // exist anywhere in the database, instead of a query per row.
  const incomingIds = rows.map(row => String(row[colFor.visitorId] || '').trim()).filter(Boolean);
  const alreadyPresent = await existingVisitorIds(incomingIds);

  const newRecords = [];
  const monthsTouched = new Set();
  let skippedDuplicate = 0;

  rows.forEach(row => {
    const visitorId = String(row[colFor.visitorId] || '').trim();
    if (!visitorId) return;

    if (alreadyPresent.has(visitorId)) { skippedDuplicate++; return; }

    const chatTimeRaw = String(row[colFor.chatTime] || '').trim();
    const chatDate = parseChatDate(chatTimeRaw);
    if (!chatDate || isNaN(chatDate.getTime())) return; // can't place this row on the calendar — skip it

    const yyyymm = `${chatDate.getUTCFullYear()}-${String(chatDate.getUTCMonth() + 1).padStart(2, '0')}`;

    let weekStartingDate = null;
    if (colFor.weekStartingDate) {
      const raw = String(row[colFor.weekStartingDate] || '').trim();
      const parsed = raw ? parseChatDate(raw) : null;
      if (parsed && !isNaN(parsed.getTime())) weekStartingDate = parsed.toISOString().slice(0, 10);
    }
    if (!weekStartingDate) weekStartingDate = computeWeekStart(chatDate); // fallback: Sunday-aligned week

    // Pre-filled values from a historical/completed report are imported as-is;
    // a raw weekly export simply won't have these columns, so they stay blank
    // (Time Range still gets auto-derived from the chat hour either way).
    const importedReason = colFor.reasonForMissed ? String(row[colFor.reasonForMissed] || '').trim() : '';
    const importedMissedBy = colFor.missedBy ? String(row[colFor.missedBy] || '').trim() : '';
    const importedTimeRange = colFor.timeRange ? String(row[colFor.timeRange] || '').trim() : '';

    // A historical file may reference a reason value that predates the
    // current REASON_VERTICAL_MAP — import it rather than discard data,
    // but flag it so it can be reconciled (added to the map, or corrected).
    if (importedReason && !REASON_OPTIONS.includes(importedReason)) {
      console.warn(`[import] Unrecognized Reason for Missed "${importedReason}" for visitor ${visitorId} — imported as-is, but won't count toward any vertical until added to REASON_VERTICAL_MAP.`);
    }

    newRecords.push({
      id: genId(),
      visitorId,
      department: String(row[colFor.department] || '').trim(),
      attender: String(row[colFor.attender] || '').trim(),
      dateISO: chatDate.toISOString(),
      country: String(row[colFor.country] || '').trim(),
      weekStartingDate,
      weekLabelOverride: row._sectionWeekLabel || null,
      timeRange: importedTimeRange || timeRangeForHour(chatDate.getUTCHours()),
      missedBy: importedMissedBy,
      reasonForMissed: importedReason,
      importedAt: new Date().toISOString(),
      yyyymm
    });
    monthsTouched.add(yyyymm);
  });

  if (newRecords.length) await recordsCol().insertMany(newRecords, { ordered: false });

  console.log(`[import] ${req.file.originalname}: +${newRecords.length} new, ${skippedDuplicate} duplicate(s) skipped`);
  res.json({ success: true, added: newRecords.length, skippedDuplicate, monthsTouched: [...monthsTouched] });
});

// ── Records: list + edit ───────────────────────────────────────
// Same record set as /api/records/:yyyymm, but filtered by an arbitrary
// date range instead of a single month — powers the new filter bar on the
// Import & Edit tab. Each record carries its source month (_yyyymm) so the
// edit table can still PATCH/DELETE it via the existing per-month routes.
// NOTE: must be declared before '/api/records/:yyyymm' below, or Express
// would treat "range" as a :yyyymm value and this route would never match.
app.get('/api/records/range', async (req, res) => {
  const { from, to } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ success: false, message: 'from/to must be YYYY-MM-DD' });
  }
  const fromTime = new Date(from + 'T00:00:00Z').getTime();
  const toTime = new Date(to + 'T23:59:59.999Z').getTime();
  if (isNaN(fromTime) || isNaN(toTime) || fromTime > toTime) {
    return res.status(400).json({ success: false, message: 'Invalid date range' });
  }
  const all = await readAllRecords();
  const inRange = all.filter(r => {
    const t = new Date(r.dateISO).getTime();
    return t >= fromTime && t <= toTime;
  });
  const records = assignWeekLabels(inRange).sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
  res.json({ success: true, from, to, records, reasonOptions: REASON_OPTIONS, timeRangeOptions: TIME_RANGE_OPTIONS, verticals: VERTICALS });
});

app.get('/api/records/:yyyymm', async (req, res) => {
  const { yyyymm } = req.params;
  if (!isValidMonth(yyyymm)) return res.status(400).json({ success: false, message: 'Expected month format YYYY-MM' });
  const data = await readMonth(yyyymm);
  const records = assignWeekLabels((data.records || []).map(r => ({ ...r, _yyyymm: yyyymm })))
    .sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
  res.json({ success: true, yyyymm, records, reasonOptions: REASON_OPTIONS, timeRangeOptions: TIME_RANGE_OPTIONS, verticals: VERTICALS });
});

app.patch('/api/records/:yyyymm/:id', requireAdmin, async (req, res) => {
  const { yyyymm, id } = req.params;
  if (!isValidMonth(yyyymm)) return res.status(400).json({ success: false, message: 'Expected month format YYYY-MM' });
  const { missedBy, reasonForMissed, timeRange } = req.body || {};

  if (reasonForMissed && !REASON_OPTIONS.includes(reasonForMissed)) {
    return res.status(400).json({ success: false, message: `Unknown reason "${reasonForMissed}". Add it to REASON_VERTICAL_MAP in server.js first.` });
  }
  if (timeRange && !TIME_RANGE_OPTIONS.includes(timeRange)) {
    return res.status(400).json({ success: false, message: `Unknown time range "${timeRange}".` });
  }

  const $set = {};
  if (missedBy !== undefined) $set.missedBy = String(missedBy).slice(0, 500);
  if (reasonForMissed !== undefined) $set.reasonForMissed = reasonForMissed;
  if (timeRange !== undefined) $set.timeRange = timeRange;

  // Match on id alone (globally unique) — the yyyymm in the URL is kept only
  // for a clear, RESTful path; it's not required for Mongo to find the row.
  const result = await recordsCol().findOneAndUpdate({ id }, { $set }, { returnDocument: 'after', projection: { _id: 0 } });
  if (!result) return res.status(404).json({ success: false, message: 'Record not found.' });
  res.json({ success: true, record: result });
});

app.delete('/api/records/:yyyymm/:id', requireAdmin, async (req, res) => {
  const { yyyymm, id } = req.params;
  if (!isValidMonth(yyyymm)) return res.status(400).json({ success: false, message: 'Expected month format YYYY-MM' });
  const result = await recordsCol().deleteOne({ id });
  res.json({ success: true, removed: result.deletedCount });
});

// Bulk delete — used by the "select all" checkboxes in the edit table
app.post('/api/records/:yyyymm/delete-bulk', requireAdmin, async (req, res) => {
  const { yyyymm } = req.params;
  const { ids } = req.body || {};
  if (!isValidMonth(yyyymm)) return res.status(400).json({ success: false, message: 'Expected month format YYYY-MM' });
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, message: 'ids array required' });
  const result = await recordsCol().deleteMany({ id: { $in: ids } });
  res.json({ success: true, removed: result.deletedCount });
});

// Delete an entire month in one click — e.g. to wipe out a bad/duplicate import
app.delete('/api/months/:yyyymm', requireAdmin, async (req, res) => {
  const { yyyymm } = req.params;
  if (!isValidMonth(yyyymm)) return res.status(400).json({ success: false, message: 'Expected month format YYYY-MM' });
  await recordsCol().deleteMany({ yyyymm });
  console.log(`[months] Deleted entire month ${yyyymm}`);
  res.json({ success: true, yyyymm });
});

// ── Reports ──────────────────────────────────────────────────
function filterByVertical(records, vertical) {
  if (!vertical || vertical === 'All') return records;
  return records.filter(r => verticalForReason(r.reasonForMissed) === vertical);
}

// Shared shape for all three matrix reports: rows = time ranges actually
// seen, columns = whatever grain is asked for (week / month / year).
function buildTimeSlotMatrix(records, getColumnKey, getColumnLabel, sortFn) {
  const columnKeys = [...new Set(records.map(getColumnKey))].sort(sortFn);
  const columns = columnKeys.map(getColumnLabel);
  const timeRanges = TIME_RANGE_OPTIONS.filter(tr => records.some(r => r.timeRange === tr));

  const matrix = timeRanges.map(tr => {
    const row = { timeRange: tr };
    let rowTotal = 0;
    columnKeys.forEach(key => {
      const label = getColumnLabel(key);
      const count = records.filter(r => getColumnKey(r) === key && r.timeRange === tr).length;
      row[label] = count;
      rowTotal += count;
    });
    row.total = rowTotal;
    return row;
  });

  const columnTotals = { timeRange: 'Total' };
  let grandTotal = 0;
  columnKeys.forEach(key => {
    const label = getColumnLabel(key);
    const t = records.filter(r => getColumnKey(r) === key).length;
    columnTotals[label] = t;
    grandTotal += t;
  });
  columnTotals.total = grandTotal;

  return { columns, matrix, columnTotals };
}

// Weekly: columns = each week-of-month within the selected month
app.get('/api/report/matrix/weekly/:yyyymm', async (req, res) => {
  const { yyyymm } = req.params;
  const vertical = req.query.vertical || 'All';
  if (!isValidMonth(yyyymm)) return res.status(400).json({ success: false, message: 'Expected month format YYYY-MM' });

  const monthData = await readMonth(yyyymm);
  const labeled = assignWeekLabels(monthData.records || []);
  const filtered = filterByVertical(labeled, vertical);
  const { columns, matrix, columnTotals } = buildTimeSlotMatrix(
    filtered, r => r.weekLabel, label => label, (a, b) => parseInt(a) - parseInt(b)
  );
  res.json({ success: true, yyyymm, vertical, columns, matrix, columnTotals });
});

// Monthly: columns = each month within the selected year
app.get('/api/report/matrix/monthly/:year', async (req, res) => {
  const { year } = req.params;
  const vertical = req.query.vertical || 'All';
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ success: false, message: 'Expected year format YYYY' });

  const allRecords = await readAllRecords();
  const all = allRecords.filter(r => r._yyyymm.startsWith(year));
  const filtered = filterByVertical(all, vertical);
  const { columns, matrix, columnTotals } = buildTimeSlotMatrix(
    filtered, r => r._yyyymm, monthLabelFor, (a, b) => a.localeCompare(b)
  );
  res.json({ success: true, year, vertical, columns, matrix, columnTotals });
});

// Yearly: columns = every year present in the data
app.get('/api/report/matrix/yearly', async (req, res) => {
  const vertical = req.query.vertical || 'All';
  const all = await readAllRecords();
  const filtered = filterByVertical(all, vertical);
  const { columns, matrix, columnTotals } = buildTimeSlotMatrix(
    filtered, r => r._yyyymm.slice(0, 4), y => y, (a, b) => a.localeCompare(b)
  );
  res.json({ success: true, vertical, columns, matrix, columnTotals });
});

// Monthly reason-for-missed breakdown
app.get('/api/report/monthly/:yyyymm', async (req, res) => {
  const { yyyymm } = req.params;
  const vertical = req.query.vertical || 'All';
  if (!isValidMonth(yyyymm)) return res.status(400).json({ success: false, message: 'Expected month format YYYY-MM' });

  const data = await readMonth(yyyymm);
  const filtered = filterByVertical(data.records || [], vertical);

  const counts = {};
  filtered.forEach(r => {
    const key = r.reasonForMissed || '(not yet filled in)';
    counts[key] = (counts[key] || 0) + 1;
  });
  const breakdown = Object.entries(counts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  res.json({ success: true, yyyymm, vertical, total: filtered.length, breakdown });
});

app.get('/api/meta', (req, res) => {
  res.json({ success: true, reasonOptions: REASON_OPTIONS, timeRangeOptions: TIME_RANGE_OPTIONS, verticals: VERTICALS, reasonVerticalMap: REASON_VERTICAL_MAP });
});

// ── Trend reports — span ALL uploaded data, not just one month ──
// Each bucketed by whatever grain is asked for, filtered by vertical.
app.get('/api/report/trend/weekly', async (req, res) => {
  const vertical = req.query.vertical || 'All';
  const all = filterByVertical(await readAllRecords(), vertical);
  const starts = [...new Set(all.map(r => r.weekStartingDate).filter(Boolean))].sort();
  const buckets = starts.map(s => ({
    weekStartingDate: s,
    label: formatWeekRangeLabel(s),
    count: all.filter(r => r.weekStartingDate === s).length
  }));
  res.json({ success: true, vertical, buckets });
});

app.get('/api/report/trend/monthly', async (req, res) => {
  const vertical = req.query.vertical || 'All';
  const all = filterByVertical(await readAllRecords(), vertical);
  const months = [...new Set(all.map(r => r._yyyymm))].sort();
  const buckets = months.map(m => ({
    yyyymm: m,
    label: monthLabelFor(m),
    count: all.filter(r => r._yyyymm === m).length
  }));
  res.json({ success: true, vertical, buckets });
});

app.get('/api/report/trend/yearly', async (req, res) => {
  const vertical = req.query.vertical || 'All';
  const all = filterByVertical(await readAllRecords(), vertical);
  const years = [...new Set(all.map(r => r._yyyymm.slice(0, 4)))].sort();
  const buckets = years.map(y => ({
    year: y,
    label: y,
    count: all.filter(r => r._yyyymm.startsWith(y)).length
  }));
  res.json({ success: true, vertical, buckets });
});

// ── Executive Reports dashboard — single call, any date range ──
// Replaces the old separate weekly/monthly/yearly/reason endpoints for the
// Reports UI: pick any From/To range (or a preset) and every chart/KPI on
// the page is computed from that same window, filtered by vertical.
app.get('/api/report/range', async (req, res) => {
  const { from, to } = req.query;
  const vertical = req.query.vertical || 'All';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ success: false, message: 'from/to must be YYYY-MM-DD' });
  }
  const fromTime = new Date(from + 'T00:00:00Z').getTime();
  const toTime = new Date(to + 'T23:59:59.999Z').getTime();
  if (isNaN(fromTime) || isNaN(toTime) || fromTime > toTime) {
    return res.status(400).json({ success: false, message: 'Invalid date range' });
  }

  const allRecords = await readAllRecords();
  const inRange = allRecords.filter(r => {
    const t = new Date(r.dateISO).getTime();
    return t >= fromTime && t <= toTime;
  });
  const filtered = filterByVertical(inRange, vertical);
  const total = filtered.length;

  const reasonCounts = {};
  filtered.forEach(r => { const k = r.reasonForMissed || '(not yet filled in)'; reasonCounts[k] = (reasonCounts[k] || 0) + 1; });
  const byReason = Object.entries(reasonCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  const verticalCounts = {};
  filtered.forEach(r => { const v = verticalForReason(r.reasonForMissed) || 'Unclassified'; verticalCounts[v] = (verticalCounts[v] || 0) + 1; });
  const byVertical = Object.entries(verticalCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  const timeSlotCounts = {};
  filtered.forEach(r => { if (r.timeRange) timeSlotCounts[r.timeRange] = (timeSlotCounts[r.timeRange] || 0) + 1; });
  const byTimeSlot = TIME_RANGE_OPTIONS.filter(t => timeSlotCounts[t]).map(name => ({ name, value: timeSlotCounts[name] }));

  const deptCounts = {};
  filtered.forEach(r => { const d = r.department || 'Unknown'; deptCounts[d] = (deptCounts[d] || 0) + 1; });
  const byDepartment = Object.entries(deptCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);

  // Which tech was recorded as having missed the chat (the "Missed By" free-
  // text field). Blank/unfilled rows are intentionally excluded here — they're
  // already surfaced separately via missedByFilledPct — so this chart only
  // reflects rows someone has actually attributed to a person.
  const missedByCounts = {};
  filtered.forEach(r => { const name = (r.missedBy || '').trim(); if (name) missedByCounts[name] = (missedByCounts[name] || 0) + 1; });
  const byMissedBy = Object.entries(missedByCounts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10);

  const weekCounts = {};
  filtered.forEach(r => { const k = r.weekStartingDate || 'unknown'; weekCounts[k] = (weekCounts[k] || 0) + 1; });
  const byWeek = Object.entries(weekCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => ({ name: key === 'unknown' ? 'Unknown' : formatWeekRangeLabel(key), value }));

  const days = Math.max(1, Math.round((toTime - fromTime) / 86400000) + 1);
  const topReason = byReason[0] || null;
  const topTimeSlot = [...byTimeSlot].sort((a, b) => b.value - a.value)[0] || null;
  const topMissedBy = byMissedBy[0] || null;
  const missedByFilledCount = filtered.filter(r => r.missedBy && r.missedBy.trim()).length;
  const reasonFilledCount = filtered.filter(r => r.reasonForMissed && r.reasonForMissed.trim()).length;

  res.json({
    success: true, from, to, vertical, total,
    avgPerDay: total / days,
    topReason, topTimeSlot, topMissedBy,
    reasonFilledPct: total ? Math.round((reasonFilledCount / total) * 100) : 0,
    missedByFilledPct: total ? Math.round((missedByFilledCount / total) * 100) : 0,
    byReason, byVertical, byTimeSlot, byDepartment, byWeek, byMissedBy
  });
});

// Which months actually have data — powers the month picker. A month only
// ever exists in the database as a value on real records now (no more empty
// "ghost" files to guard against), so this is just a distinct query.
app.get('/api/months', async (req, res) => {
  const months = (await recordsCol().distinct('yyyymm')).sort().reverse();
  res.json({ success: true, months });
});

// Monthly combined comparison — one row per calendar month (Jan..Dec), one
// column per year present in the data, so e.g. "Jan 2025" and "Jan 2026" can
// be compared side by side instead of every month scrolling past in one
// long timeline. Powers the "Monthly Comparison" report tab.
app.get('/api/report/comparison/monthly', async (req, res) => {
  const vertical = req.query.vertical || 'All';
  const all = filterByVertical(await readAllRecords(), vertical);

  const years = [...new Set(all.map(r => r._yyyymm.slice(0, 4)))].sort();
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const rows = MONTH_NAMES.map((name, i) => {
    const monthNum = String(i + 1).padStart(2, '0');
    const row = { month: name };
    let rowTotal = 0;
    years.forEach(y => {
      const count = all.filter(r => r._yyyymm === `${y}-${monthNum}`).length;
      row[y] = count;
      rowTotal += count;
    });
    row.total = rowTotal;
    return row;
  }).filter(row => years.some(y => row[y] > 0)); // skip calendar months with no data in any year

  const yearTotals = { month: 'Total' };
  let grandTotal = 0;
  years.forEach(y => {
    const t = all.filter(r => r._yyyymm.startsWith(y)).length;
    yearTotals[y] = t;
    grandTotal += t;
  });
  yearTotals.total = grandTotal;

  res.json({ success: true, vertical, years, rows, yearTotals });
});

// Which years actually have data — powers the Monthly report's year picker
app.get('/api/years', async (req, res) => {
  const months = await recordsCol().distinct('yyyymm');
  const years = [...new Set(months.map(m => m.slice(0, 4)))].sort().reverse();
  res.json({ success: true, years });
});

// Connect to MongoDB first, THEN start accepting HTTP requests — this way
// nothing can ever race a request against a not-yet-ready database
// connection, and a bad/missing MONGODB_URI fails loudly at startup instead
// of surfacing as a mysterious 500 on the first click.
connectDB()
  .then(() => seedAdminIfNeeded())
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Missed Chat Tracker running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[startup] Could not connect to MongoDB — server not started.');
    console.error(err.message);
    process.exit(1);
  });
