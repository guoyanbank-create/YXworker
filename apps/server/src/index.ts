/** 服务入口：打开 SQLite、写入种子数据、启动本机单进程服务。 */
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureSeed, ensureSeedExtras } from './seed/seed.js';

const db = openDb(config.dbFile);
if (config.seedDemo) {
  const seeded = ensureSeed(db);
  ensureSeedExtras(db);
  if (!seeded.skipped) {
    console.log(`[server] 已写入演示数据: project=${seeded.projectId} document=${seeded.documentId}`);
  }
}

const app = createApp({ db, config });
const server = app.listen(config.port, config.host, () => {
  console.log(`[server] ${config.appName} ${config.version} 运行于 http://${config.host}:${config.port}`);
  console.log(`[server] 数据库: ${config.dbFile}`);
  console.log(`[server] 模型凭据: ${config.llmConfigured ? '已配置（仅服务端持有）' : '未配置（仅可使用模拟执行器）'}`);
});

function shutdown(signal: string): void {
  console.log(`[server] 收到 ${signal}，正在关闭…`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
