/** Offline check of the sender→person staff map learning rules (no API). */
import '../bootstrap.js';
import { store } from '../db/store.js';
import { matchPerson } from '../expense.js';

console.log('matchPerson("Christi Andrian"):', matchPerson('Christi Andrian'), '(want CHRISTI)');
console.log('auto learn:', store.setStaffPerson('628111@c.us', 'CHRISTI', 'auto'), '-> get', store.getStaffPerson('628111@c.us'), '(want CHRISTI)');

store.setStaffPerson('628999@c.us', 'LING', 'manual');
console.log('auto must NOT overwrite manual:', store.setStaffPerson('628999@c.us', 'JAY', 'auto'), '-> get', store.getStaffPerson('628999@c.us'), '(want false, LING)');
console.log('manual CAN overwrite manual :', store.setStaffPerson('628999@c.us', 'PUTRI', 'manual'), '-> get', store.getStaffPerson('628999@c.us'), '(want true, PUTRI)');

// cleanup the test rows so the dev ledger isn't polluted
import Database from 'better-sqlite3';
import { config } from '../config.js';
const db = new Database(config.paths.dbFile);
db.prepare("DELETE FROM staff_map WHERE wa_id IN ('628111@c.us','628999@c.us')").run();
console.log('cleaned up test rows.');
