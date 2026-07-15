// One-time migration: copies your existing local data/records/*.json files
// into MongoDB. Run this ONCE, after setting MONGODB_URI, and BEFORE you
// deploy the MongoDB-backed server.js — it reads straight off disk, so it
// only works from the machine (or old deployment) that still has your
// data/ folder.
//
// Safe to re-run: it skips any record whose `id` already exists in MongoDB,
// so running it twice won't create duplicates.
//
// USAGE:
//   MONGODB_URI="mongodb+srv://..." node migrate-to-mongodb.js

const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (e) { /* optional */ }
const { connectDB, closeDB } = require('./db');

const RECORDS_DIR = path.join(__dirname, 'data', 'records');

async function main() {
  if (!fs.existsSync(RECORDS_DIR)) {
    console.log(`No local data found at ${RECORDS_DIR} — nothing to migrate. If this is a brand-new setup, that's expected.`);
    return;
  }

  const files = fs.readdirSync(RECORDS_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) {
    console.log('No record files found — nothing to migrate.');
    return;
  }

  const db = await connectDB();
  const col = db.collection('records');

  let totalRead = 0, inserted = 0, skippedExisting = 0;

  for (const f of files) {
    const yyyymm = f.replace('.json', '');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, f), 'utf8'));
    } catch (e) {
      console.warn(`Skipping unreadable file ${f}: ${e.message}`);
      continue;
    }
    const records = data.records || [];
    totalRead += records.length;
    if (!records.length) continue;

    const ids = records.map(r => r.id);
    const existingIds = new Set((await col.find({ id: { $in: ids } }, { projection: { id: 1 } }).toArray()).map(d => d.id));

    const toInsert = records
      .filter(r => !existingIds.has(r.id))
      .map(r => ({ ...r, yyyymm })); // yyyymm now lives on the document itself, not just the filename

    skippedExisting += records.length - toInsert.length;

    if (toInsert.length) {
      await col.insertMany(toInsert, { ordered: false });
      inserted += toInsert.length;
    }

    console.log(`${f}: ${records.length} record(s) → ${toInsert.length} inserted, ${records.length - toInsert.length} already in MongoDB`);
  }

  console.log(`\nDone. Read ${totalRead} record(s) from disk — ${inserted} newly inserted, ${skippedExisting} already present in MongoDB.`);
  console.log('Your local data/ folder is untouched — keep it as a backup until you\'ve confirmed the app works against MongoDB.');
  await closeDB();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
