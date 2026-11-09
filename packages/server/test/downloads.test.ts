import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  candidateName,
  finalizeFile,
  sanitizeFileName,
  uniquePath,
} from '../src/services/downloads';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lanfly-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('文件名清洗', () => {
  it('去掉路径、控制字符和非法字符', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j.txt')).toBe('c_d_e_f_g_h_i_j.txt');
  });

  it('处理空名称、隐藏文件名和 Windows 保留名', () => {
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('   ')).toBe('file');
    expect(sanitizeFileName('...')).toBe('file');
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    expect(sanitizeFileName('LPT9.log')).toBe('_LPT9.log');
  });

  it('超长名称保留扩展名并截断', () => {
    const result = sanitizeFileName(`${'啊'.repeat(300)}.txt`);
    expect(Array.from(result).length).toBeLessThanOrEqual(180);
    expect(result.endsWith('.txt')).toBe(true);
  });
});

describe('重名文件', () => {
  it('按序号生成候选名', () => {
    expect(candidateName('report.pdf', 0)).toBe('report.pdf');
    expect(candidateName('report.pdf', 1)).toBe('report (1).pdf');
    expect(candidateName('README', 2)).toBe('README (2)');
  });

  it('找到第一个不存在的路径', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.txt'), 'a');
    await writeFile(path.join(dir, 'a (1).txt'), 'b');
    expect(path.basename(uniquePath(dir, 'a.txt'))).toBe('a (2).txt');
  });

  it('落盘时原子地避免覆盖已有文件', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'note.txt'), 'original');
    const temp = path.join(dir, '.part');
    await writeFile(temp, 'incoming');

    const first = await finalizeFile(temp, dir, 'note.txt');
    expect(path.basename(first)).toBe('note (1).txt');
    expect(await readFile(first, 'utf8')).toBe('incoming');
    expect(await readFile(path.join(dir, 'note.txt'), 'utf8')).toBe('original');
  });
});
