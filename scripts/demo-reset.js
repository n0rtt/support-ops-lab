import { resetDemoDatabase } from '../server/database.js';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--confirm') {
  console.error('Usage: npm run demo:reset -- --confirm');
  process.exitCode = 2;
} else {
  try {
    resetDemoDatabase({ confirmed: true });
    console.log('Demo database was reset to the initial synthetic cases.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
