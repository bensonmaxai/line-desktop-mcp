import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { purepngDimensions } from './line-ocr.mjs';
import { LineToolError } from './line-runtime.mjs';
const execFile = promisify(execFileCallback);
export async function locateLineDateCapsule(image, { timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000)
    throw new LineToolError('LINE_BOUND_CONTEXT_UNVERIFIED', 'Invalid date capsule timeout.');
  const dimensions = purepngDimensions(image);
  if (dimensions.width !== 250 || dimensions.height < 14 || dimensions.height > 50)
    throw new LineToolError('LINE_BOUND_CONTEXT_UNVERIFIED', 'Invalid date capsule crop.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'line-date-capsule-'));
  try {
    const inputPath = path.join(directory, 'input.png');
    await fs.writeFile(inputPath, Buffer.from(image.data, 'base64'), { flag: 'wx' });
    const { stdout } = await execFile(path.join(process.env.SystemRoot || 'C:/Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./locate-line-date-capsule.ps1', import.meta.url)),
      '-InputPath', inputPath], { windowsHide: true, timeout: timeoutMs, maxBuffer: 65536, encoding: 'utf8' });
    const result = JSON.parse(stdout.trim());
    if (result.success !== true || result.width !== dimensions.width || result.height !== dimensions.height)
      throw new LineToolError('LINE_BOUND_CONTEXT_UNVERIFIED', 'Date capsule could not be measured.');
    return result.dateCapsule === true;
  } finally {
    // Owned mkdtemp directory only; no caller supplied path is removed.
    const ownedPath = path.resolve(directory);
    if (path.dirname(ownedPath) !== path.resolve(os.tmpdir())
      || !path.basename(ownedPath).startsWith('line-date-capsule-'))
      throw new LineToolError('LINE_DATE_CAPSULE_CLEANUP_FAILED', 'Temporary capsule path escaped its owner.');
    await fs.rm(ownedPath, { recursive: true, force: true });
  }
}
