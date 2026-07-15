// Single place that owns the MongoDB connection. Everything else in the app
// calls getDB() to get a ready-to-use database handle — connectDB() is only
// called once, at startup, before the HTTP server starts accepting requests.
const { MongoClient } = require('mongodb');

let client = null;
let db = null;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI environment variable is not set. ' +
      'Create a .env file locally (see .env.example) or set it in your hosting platform\'s environment variables.'
    );
  }

  client = new MongoClient(uri);
  await client.connect();

  // Database name comes from the connection string's path if present,
  // otherwise falls back to MONGODB_DB (or a sane default) — lets you point
  // at "mongodb+srv://.../missed_chat_tracker" directly, or set it separately.
  const dbNameFromUri = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'https://')).pathname.replace('/', '');
  db = client.db(dbNameFromUri || process.env.MONGODB_DB || 'missed_chat_tracker');

  const records = db.collection('records');
  await records.createIndex({ id: 1 }, { unique: true });
  await records.createIndex({ visitorId: 1 });
  await records.createIndex({ yyyymm: 1 });
  await records.createIndex({ dateISO: 1 });

  console.log(`[db] Connected to MongoDB — database "${db.databaseName}"`);
  return db;
}

function getDB() {
  if (!db) throw new Error('Database not connected yet — connectDB() must complete before any request is handled.');
  return db;
}

async function closeDB() {
  if (client) await client.close();
}

module.exports = { connectDB, getDB, closeDB };
