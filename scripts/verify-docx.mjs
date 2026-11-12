#!/usr/bin/env node
/**
 * 用 DSH 随包的 LibreOffice 引擎（MPL-2.0）把导出的 DOCX 渲染为 PDF/PNG，作为
 * “Word 导出可用性”的自动化证据（本机无 Microsoft Office/WPS，如实说明）。
 *
 * 用法：node scripts/verify-docx.mjs <input.docx> [outputDir]
 * 环境变量：LIBREOFFICE_KIT_PATH 可显式指定 @deepseek-ai/libreoffice-kit 的 lib/index.js。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function resolveKit() {
  const candidates = [];
  if (process.env.LIBREOFFICE_KIT_PATH) candidates.push(process.env.LIBREOFFICE_KIT_PATH);
  try {
    const globalRoot = execFileSync('pnpm', ['root', '-g'], { encoding: 'utf8' }).trim();
    candidates.push(join(globalRoot, '@deepseek-ai/libreoffice-kit/lib/index.js'));
    candidates.push(join(globalRoot, 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js'));
  } catch {
    // pnpm 不可用时继续尝试已知 DSH 安装位置
  }
  candidates.push(
    join(
      homedir(),
      '.local/share/pnpm/global/v11/5aa5-1a1c794f976-e4c464ac8d7c0401/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js',
    ),
  );
  return candidates.find((p) => existsSync(p));
}

const inputArg = process.argv[2];
if (!inputArg) {
  console.error('用法: node scripts/verify-docx.mjs <input.docx> [outputDir]');
  process.exit(2);
}
const inputPath = isAbsolute(inputArg) ? inputArg : resolve(inputArg);
if (!existsSync(inputPath)) {
  console.error(`输入文件不存在: ${inputPath}`);
  process.exit(2);
}
const outputDir = resolve(process.argv[3] ?? mkdtempSync(join(tmpdir(), 'yxworker-docx-')));

const kitPath = resolveKit();
if (!kitPath) {
  console.error('未找到 @deepseek-ai/libreoffice-kit，跳过渲染验证（不阻塞主流程）。');
  process.exit(3);
}
const kit = await import(pathToFileURL(kitPath).href);

const converter = await kit.createConverter({ timeoutMs: 180_000 });
try {
  const imagesDir = join(outputDir, 'pages');
  const images = await converter.renderImages({
    inputPath,
    outputDir: imagesDir,
    pages: 'all',
    dpi: 110,
  });
  const pdfPath = join(outputDir, 'render.pdf');
  let pdf = null;
  try {
    pdf = await converter.render({ inputPath, outputPath: pdfPath });
  } catch (error) {
    console.warn(`PDF 渲染跳过: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pageFiles = existsSync(imagesDir)
    ? readdirSync(imagesDir).filter((f) => f.endsWith('.png'))
    : [];
  console.log(
    JSON.stringify(
      {
        inputPath,
        outputDir,
        backend: images.backend,
        rasterEngine: images.rasterEngine,
        pageCount: images.pageCount,
        missingFonts: images.missingFonts,
        images: images.images.map((img) => ({ path: img.path, width: img.width, height: img.height })),
        pageFiles,
        pdf: pdf ? { path: pdfPath, bytes: statSync(pdfPath).size, backend: pdf.backend } : null,
      },
      null,
      2,
    ),
  );
  if (pageFiles.length === 0) {
    console.error('渲染未产生页面图片，判定为失败。');
    process.exit(1);
  }
} finally {
  await converter.dispose();
}
void dirname;
