// One-time fix for data already imported under the old, buggy date parser.
//
// The old code parsed CSV timestamps like "01 Jul, 2026 00:15:06" with a
// plain `new Date(...)`, which silently used the server's OS timezone.
// On a server set to IST (UTC+5:30), every imported timestamp got shifted
// back by 5 hours 30 minutes when converted to UTC for storage — e.g.
// "01 Jul 00:15" was stored as "30 Jun 18:45". That misfiled rows into the
// wrong week and sometimes the wrong month entirely.
//
// This script shifts every already-stored record forward by the offset
// (default 5h30m, i.e. +330 minutes) to undo that, and re-files each record
// into the correct month/week based on the corrected timestamp. It always
// makes a full backup of data/records/ before touching anything.
//
// USAGE:
//   node fix-existing-dates.js                 → dry run, shows what would change
//   node fix-existing-dates.js --apply          → applies the fix (with backup)
//   node fix-existing-dates.js --apply --offset-minutes=330   → custom offset
//
// If your server was NOT running in IST, figure out the correct offset first:
// take one row you know the true date/time for, compare it to what's stored,
// and pass the difference (in minutes) via --offset-minutes. Run without
// --apply first to sanity-check the "would become" column before applying.

const fs = require('fs');
const path = require('path');

const RECORDS_DIR = path.join(__dirname, 'data', 'records');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const offsetArg = args.find(a => a.startsWith('--offset-minutes='));
const OFFSET_MINUTES = offsetArg ? parseInt(offsetArg.split('=')[1], 10) : 330; // default: undo IST (+5:30)

function computeWeekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

if (!fs.existsSync(RECORDS_DIR)) {
  console.error(`No data directory found at ${RECORDS_DIR} — nothing to fix.`);
  process.exit(1);
}

const files = fs.readdirSync(RECORDS_DIR).filter(f => f.endsWith('.json'));
if (!files.length) {
  console.log('No record files found — nothing to fix.');
  process.exit(0);
}

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — shifting stored timestamps by +${OFFSET_MINUTES} minutes and re-filing by corrected date.\n`);

// Load everything first, keyed by original file.
const byFile = {};
files.forEach(f => {
  byFile[f] = JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, f), 'utf8'));
});

// Backup before making any changes.
if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, 'data', `records-backup-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  files.forEach(f => fs.copyFileSync(path.join(RECORDS_DIR, f), path.join(backupDir, f)));
  console.log(`Backed up original files to: ${backupDir}\n`);
}

const newByMonth = {}; // corrected yyyymm -> records[]
let changed = 0, unchanged = 0;

files.forEach(f => {
  const data = byFile[f];
  (data.records || []).forEach(r => {
    const oldDate = new Date(r.dateISO);
    const newDate = new Date(oldDate.getTime() + OFFSET_MINUTES * 60000);
    const newYYYYMM = `${newDate.getUTCFullYear()}-${String(newDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const oldYYYYMM = f.replace('.json', '');

    if (newYYYYMM !== oldYYYYMM || newDate.getTime() !== oldDate.getTime()) {
      changed++;
      console.log(`  #${(r.visitorId || r.id)}  ${oldDate.toISOString()} (in ${oldYYYYMM})  →  ${newDate.toISOString()} (in ${newYYYYMM})`);
    } else {
      unchanged++;
    }

    const corrected = {
      ...r,
      dateISO: newDate.toISOString(),
      weekStartingDate: computeWeekStart(newDate),
    };
    (newByMonth[newYYYYMM] ||= []).push(corrected);
  });
});

console.log(`\n${changed} record(s) would move/shift, ${unchanged} unchanged.`);

if (!APPLY) {
  console.log('\nThis was a dry run — no files were changed. Re-run with --apply to write the fix.');
  process.exit(0);
}

// Remove all existing month files, then write the corrected set fresh —
// this naturally handles rows moving between months.
files.forEach(f => fs.unlinkSync(path.join(RECORDS_DIR, f)));
Object.entries(newByMonth).forEach(([yyyymm, records]) => {
  fs.writeFileSync(path.join(RECORDS_DIR, `${yyyymm}.json`), JSON.stringify({ records }, null, 2), 'utf8');
});

console.log(`\nDone. Wrote ${Object.keys(newByMonth).length} month file(s). Restart the server and refresh the page.`);
