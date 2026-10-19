import { initializeDatabase, openDemoDatabase } from '../server/database.js';

const db = openDemoDatabase();
try {
  initializeDatabase(db);
  console.log('Demo database is initialized.');
} finally {
  db.close();
}
