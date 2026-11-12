/** CLI：向本地数据库写入演示种子数据（幂等）。 */
import { config } from '../config.js';
import { openDb } from '../db.js';
import { ensureSeed } from './seed.js';

const db = openDb(config.dbFile);
const result = ensureSeed(db);
console.log(
  result.skipped
    ? `种子数据已存在：project=${result.projectId} document=${result.documentId}`
    : `已写入种子数据：project=${result.projectId} document=${result.documentId}`,
);
db.close();
