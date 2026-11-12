/**
 * 测试用最小 ZIP 读取器（仅 devDependency 之外的自包含实现，避免引入新依赖）。
 *
 * 用途：验证 DOCX 导出的二进制确实是合法 zip，并取出 `word/document.xml` 等条目做断言。
 * 仅支持 store(0) / deflate(8)，足够覆盖 docx 的打包方式。
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

export interface ZipEntry {
  name: string;
  /** 解压后的内容。 */
  data: Buffer;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('不是合法的 ZIP 文件：未找到 End of Central Directory');
}

function decompress(entry: Buffer, method: number): Buffer {
  if (method === 0) return Buffer.from(entry);
  if (method === 8) return inflateRawSync(entry);
  throw new Error(`不支持的 ZIP 压缩方法: ${method}`);
}

/** 解析 zip，返回文件名 → 解压后内容。 */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`不是合法的 ZIP 文件：中央目录条目 ${index} 签名错误`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`不是合法的 ZIP 文件：本地文件头 ${name} 签名错误`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      name,
      data: decompress(raw, method),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 判断二进制是否以 ZIP 魔数 `PK\x03\x04` 开头。 */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === LOCAL_FILE_SIGNATURE;
}
