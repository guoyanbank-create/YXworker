#!/usr/bin/env node
/**
 * 一条命令启动：缺构建产物时自动构建，然后拉起本机前后端（同一端口）。
 * 用法：pnpm install && pnpm start
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const webDist = join(root, 'apps/web/dist/index.html');
const serverDist = join(root, 'apps/server/dist/index.js');

if (!existsSync(webDist) || !existsSync(serverDist)) {
  console.log('[start] 未找到构建产物，先执行 pnpm build …');
  const build = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('[start] 构建失败，已退出。');
    process.exit(build.status ?? 1);
  }
}

const port = process.env.PORT ?? '8787';
const host = process.env.HOST ?? '127.0.0.1';
console.log(`[start] YXworker 启动于 http://${host}:${port} （Ctrl+C 停止）`);
const child = spawn(process.execPath, [join(root, 'apps/server/dist/index.js')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
