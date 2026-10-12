// db-check.js — verifies the store layer can actually persist.
// Run: npm run db:check
import { loadStore, saveStore, closePersist } from '../src/store/persist.js';

async function main() {
  const problems = [];
  let store = null;

  try {
    store = await loadStore();
    console.log('loadStore: OK');
  } catch (error) {
    problems.push(`loadStore failed: ${error.message}`);
    console.error(`loadStore: FAIL — ${error.message}`);
  }

  if (store) {
    const hasSettings = store && typeof store === 'object' && 'settings' in store;
    console.log(`settings key present: ${hasSettings ? 'yes' : 'no'}`);

    try {
      await saveStore(store);
      console.log('saveStore: OK');
    } catch (error) {
      problems.push(`saveStore failed: ${error.message}`);
      console.error(`saveStore: FAIL — ${error.message}`);
    }
  }

  try {
    await closePersist();
    console.log('closePersist: OK');
  } catch (error) {
    problems.push(`closePersist failed: ${error.message}`);
    console.error(`closePersist: FAIL — ${error.message}`);
  }

  if (problems.length) {
    console.error(`\ndb:check FAILED (${problems.length} problem(s))`);
    process.exitCode = 1;
    return;
  }
  console.log('\ndb:check OK');
}

main().catch(error => {
  console.error('db:check crashed:', error);
  process.exitCode = 1;
});