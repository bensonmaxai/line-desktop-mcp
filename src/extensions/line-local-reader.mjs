import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineToolError, requireChat, configuredPythonPath } from './line-runtime.mjs';

const SCRIPT = fileURLToPath(new URL('./python/line-reader.py', import.meta.url));
const MAX_OUTPUT = 4 * 1024 * 1024;
const DEFAULT_READER_TIMEOUT_MS = 300_000;
const MIN_ENV_READER_TIMEOUT_MS = 1_000;
const MAX_READER_TIMEOUT_MS = 1_800_000;
const MIN_TERMINATION_GRACE_MS = 50;
const MAX_TERMINATION_GRACE_MS = 5_000;
const FIXED_SNAPSHOT_FILES = Object.freeze(['snapshot.edb-wal', 'snapshot.edb-shm', 'snapshot.edb-journal', 'snapshot.edb']);
const SOURCE_LIMITS = Object.freeze({
  database: Object.freeze({ setting: 'LINE_MCP_MAX_SOURCE_BYTES', defaultMaxBytes: 2_147_483_648, maxConfiguredBytes: 8_589_934_592 }),
  wal: Object.freeze({ setting: 'LINE_MCP_MAX_WAL_BYTES', defaultMaxBytes: 268_435_456, maxConfiguredBytes: 1_073_741_824 }),
  snapshot: Object.freeze({ setting: 'LINE_MCP_MAX_SNAPSHOT_BYTES', defaultMaxBytes: 2_415_919_104, maxConfiguredBytes: 9_663_676_416 }),
});
const fail = code => new LineToolError(code, 'Local LINE read did not complete. No GUI fallback or send was attempted.');
const terminationFailure = () => new LineToolError('LOCAL_READER_TERMINATION_FAILED',
  'The local LINE reader could not be confirmed stopped. Its private scratch directory was retained.', { mayStillBeRunning: true });

export function validateLocalScope(args, { allowIdentityOnly = false, allowGuiIdentityOnly = false,
  allowGuiCandidateOnly = false, allowGroupCandidateOnly = false, allowBoundDirect = false } = {}) {
  const allowGuiMode = allowIdentityOnly && allowGuiIdentityOnly;
  const allowCandidateMode = allowIdentityOnly && allowGuiCandidateOnly;
  const allowGroupCandidateMode = allowIdentityOnly && allowGroupCandidateOnly;
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['chatName', 'chatType', 'dateFrom', 'dateTo', 'messageLimit', 'query', 'cursor', 'mediaMode', 'mediaSourceRefs', 'expectedChatRef', 'expectedOwnSenderRef', 'requireUniqueName', ...(allowBoundDirect ? ['boundDirect'] : []), ...(allowIdentityOnly ? ['identityOnly'] : []), ...(allowGuiMode ? ['guiIdentityOnly'] : []), ...(allowCandidateMode ? ['guiCandidateOnly'] : []), ...(allowGroupCandidateMode ? ['groupCandidateOnly'] : [])].includes(key))) throw fail('LINE_INVALID_ARGUMENT');
  if(args.requireUniqueName!==undefined && args.requireUniqueName!==true) throw fail('LINE_INVALID_ARGUMENT');
  if (args.expectedChatRef !== undefined && !/^chat:[0-9a-f]{24}$/u.test(args.expectedChatRef)) throw fail('LINE_INVALID_ARGUMENT');
  if (args.expectedOwnSenderRef !== undefined && !/^sender:[0-9a-f]{24}$/u.test(args.expectedOwnSenderRef)) throw fail('LINE_INVALID_ARGUMENT');
  requireChat(args.chatName);
  if (args.chatType !== undefined && !['auto', 'group', 'direct'].includes(args.chatType)) throw fail('LINE_INVALID_ARGUMENT');
  if (/[\x00-\x1f]/u.test(args.chatName)) throw fail('LINE_INVALID_ARGUMENT');
  for (const field of ['dateFrom', 'dateTo']) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(args[field] ?? '') || args[field].startsWith('0000')) throw fail('LINE_INVALID_ARGUMENT');
    const date = new Date(`${args[field]}T00:00:00Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== args[field]) throw fail('LINE_INVALID_ARGUMENT');
  }
  const days = (Date.parse(args.dateTo) - Date.parse(args.dateFrom)) / 86400000;
  const messageLimit = args.messageLimit ?? 200;
  if (days < 0 || days > 30 || !Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 1000
      || (args.query !== undefined && (typeof args.query !== 'string' || !args.query.length || args.query.length > 1000 || args.query.includes('\0')))) throw fail('LINE_INVALID_ARGUMENT');
  const mediaMode = args.mediaMode ?? 'metadata';
  if (args.boundDirect !== undefined && (!allowBoundDirect || args.boundDirect !== true
    || args.chatType !== 'direct' || args.expectedChatRef === undefined || args.expectedOwnSenderRef === undefined
    || days > 2 || messageLimit > 30 || mediaMode !== 'metadata'
    || ['requireUniqueName', 'guiIdentityOnly', 'guiCandidateOnly', 'groupCandidateOnly', 'query', 'cursor', 'mediaSourceRefs'].some(key => key in args))) throw fail('LINE_INVALID_ARGUMENT');
  if (args.identityOnly !== undefined && (args.identityOnly !== true || mediaMode !== 'metadata'
      || ['query', 'cursor', 'mediaSourceRefs'].some(key => key in args))) throw fail('LINE_INVALID_ARGUMENT');
  if (args.guiIdentityOnly !== undefined && (!allowGuiMode || args.guiIdentityOnly !== true
      || args.identityOnly !== true || args.guiCandidateOnly !== undefined
      || args.groupCandidateOnly !== undefined || mediaMode !== 'metadata'
      || ['query', 'cursor', 'mediaSourceRefs'].some(key => key in args))) throw fail('LINE_INVALID_ARGUMENT');
  if (args.guiCandidateOnly !== undefined && (!allowCandidateMode || args.guiCandidateOnly !== true
      || args.identityOnly !== true || args.guiIdentityOnly !== undefined
      || args.groupCandidateOnly !== undefined
      || args.chatType !== 'direct' || mediaMode !== 'metadata'
      || ['query', 'cursor', 'mediaSourceRefs'].some(key => key in args))) throw fail('LINE_INVALID_ARGUMENT');
  if (args.groupCandidateOnly !== undefined && (!allowGroupCandidateMode || args.groupCandidateOnly !== true
      || args.identityOnly !== true || args.guiIdentityOnly !== undefined
      || args.guiCandidateOnly !== undefined || args.chatType !== 'group'
      || mediaMode !== 'metadata' || ['query', 'cursor', 'mediaSourceRefs'].some(key => key in args))) {
    throw fail('LINE_INVALID_ARGUMENT');
  }
  if ((args.mediaMode !== undefined && !['metadata', 'preview'].includes(args.mediaMode))
      || (args.mediaSourceRefs !== undefined && (mediaMode !== 'preview' || !Array.isArray(args.mediaSourceRefs)
        || args.mediaSourceRefs.length < 1 || args.mediaSourceRefs.length > 20
        || args.mediaSourceRefs.some(ref => typeof ref !== 'string' || !/^message:[0-9a-f]{24}$/u.test(ref))
        || new Set(args.mediaSourceRefs).size !== args.mediaSourceRefs.length))) throw fail('LINE_INVALID_ARGUMENT');
  if (args.cursor !== undefined) validateCursor(args.cursor, args);
  return { ...args, messageLimit, mediaMode };
}

export function validateRecentScope(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['days', 'query', 'limit'].includes(key))
      || ![14, 30].includes(args.days)
      || (args.query !== undefined && (typeof args.query !== 'string' || args.query.length < 1
        || args.query.length > 100 || /\p{Cc}/u.test(args.query)))
      || (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50))) {
    throw fail('LINE_INVALID_ARGUMENT');
  }
  return { mode: 'recentChats', days: args.days, limit: args.limit ?? 50,
    ...(args.query === undefined ? {} : { query: args.query }) };
}

export function validateCandidateScope(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['chatName', 'limit'].includes(key))) throw fail('LINE_INVALID_ARGUMENT');
  requireChat(args.chatName);
  if (/\p{Cc}/u.test(args.chatName) || !Number.isSafeInteger(args.limit ?? 20)
      || (args.limit ?? 20) < 1 || (args.limit ?? 20) > 20) throw fail('LINE_INVALID_ARGUMENT');
  return { mode: 'chatCandidates', chatName: args.chatName, limit: args.limit ?? 20 };
}

function validateCursor(value, scope) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw fail('INVALID_CURSOR');
  let token;
  try { token = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw fail('INVALID_CURSOR'); }
  if (!token || typeof token !== 'object' || Array.isArray(token)
      || Object.keys(token).sort().join(',') !== 'chat,id,scope,time,v' || token.v !== 1
      || typeof token.scope !== 'string' || !/^[0-9a-f]{64}$/u.test(token.scope)
      || typeof token.chat !== 'string' || !/^chat:[0-9a-f]{24}$/u.test(token.chat)
      || !Number.isSafeInteger(token.time)
      || !((typeof token.id === 'string' && token.id.length > 0 && [...token.id].length <= 200 && !token.id.includes('\0'))
        || Number.isSafeInteger(token.id))) throw fail('INVALID_CURSOR');
  const fields = [scope.chatName, scope.dateFrom, scope.dateTo, scope.query ?? null];
  if (scope.chatType && scope.chatType !== 'auto') fields.push(scope.chatType);
  const expected = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  if (token.scope !== expected) throw fail('CURSOR_SCOPE_MISMATCH');
  const instant = new Date(token.time + 28800000);
  if (!Number.isFinite(instant.valueOf())) throw fail('INVALID_CURSOR');
  const date = instant.toISOString().slice(0, 10);
  if (date < scope.dateFrom || date > scope.dateTo) throw fail('INVALID_CURSOR');
  return token;
}

/**
 * Start the private reader in a parent-owned, one-request directory.  The
 * Python reader receives only an opaque request ID and derives the fixed
 * directory itself; no payload path can influence snapshot placement.
 */
export function runReaderProcess(payload, options = {}) {
  let scope;
  try {
    // Internal identity flags are accepted here only because callers have
    // already passed through one of the private identity wrappers below.
    if (payload?.mode === 'keepOpenIdentity') {
      if (Object.keys(payload).length !== 1) throw fail('LINE_INVALID_ARGUMENT');
      scope = { mode: 'keepOpenIdentity' };
    } else scope = payload?.mode === 'chatCandidates'
      ? validateCandidateScope(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'mode')))
      : payload?.mode === 'recentChats'
      ? { mode: 'recentChats', ...validateRecentScope(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'mode'))) }
      : validateLocalScope(payload, { allowIdentityOnly: true, allowGuiIdentityOnly: true,
        allowGuiCandidateOnly: true, allowGroupCandidateOnly: true, allowBoundDirect: true });
  } catch (error) {
    return Promise.reject(error instanceof LineToolError ? error : fail('LINE_INVALID_ARGUMENT'));
  }

  let timeoutMs;
  try { timeoutMs = readerTimeout(options.timeoutMs); }
  catch (error) { return Promise.reject(error); }
  const pythonPath = options.pythonPath === undefined ? configuredPythonPath() : options.pythonPath;
  if (!configuredPythonPath(pythonPath)) return Promise.reject(fail('LOCAL_READER_UNAVAILABLE'));
  if (typeof options.spawnProcess !== 'undefined' && typeof options.spawnProcess !== 'function') {
    return Promise.reject(fail('LOCAL_READER_UNAVAILABLE'));
  }

  return runOwnedReader(scope, pythonPath, timeoutMs, options.spawnProcess ?? nodeSpawn);
}

function readerTimeout(override) {
  if (override !== undefined) {
    if (!Number.isSafeInteger(override) || override < 1 || override > MAX_READER_TIMEOUT_MS) {
      throw fail('LOCAL_READER_TIMEOUT_INVALID');
    }
    return override;
  }
  const configured = process.env.LINE_MCP_READER_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_READER_TIMEOUT_MS;
  if (typeof configured !== 'string' || !/^[1-9][0-9]*$/u.test(configured)) throw fail('LOCAL_READER_TIMEOUT_INVALID');
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || String(value) !== configured
      || value < MIN_ENV_READER_TIMEOUT_MS || value > MAX_READER_TIMEOUT_MS) {
    throw fail('LOCAL_READER_TIMEOUT_INVALID');
  }
  return value;
}

async function runOwnedReader(scope, pythonPath, timeoutMs, spawnProcess) {
  let request;
  try {
    request = await createReaderRequestDirectory();
  } catch (error) {
    throw error instanceof LineToolError ? error : fail('LOCAL_READER_UNAVAILABLE');
  }

  let child;
  try {
    child = spawnProcess(pythonPath, ['-B', SCRIPT], {
      env: { ...process.env, LINE_MCP_READER_REQUEST_ID: request.id },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    await cleanupAfterReaderFailure(request, fail('LOCAL_READER_UNAVAILABLE'));
    return undefined; // `cleanupAfterReaderFailure` always throws.
  }

  if (!child) {
    await cleanupAfterReaderFailure(request, fail('LOCAL_READER_UNAVAILABLE'));
    return undefined; // `cleanupAfterReaderFailure` always throws.
  }
  if (typeof child.on !== 'function' || typeof child.once !== 'function' || typeof child.kill !== 'function'
      || !child.stdin || !child.stdout || !child.stderr) {
    return awaitMalformedReaderChild(child, request, timeoutMs);
  }
  return collectReaderOutput(child, scope, request, timeoutMs);
}

function collectReaderOutput(child, scope, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let terminalError = null;
    let closed = false;
    let cleanupStarted = false;
    let responseSettled = false;
    let timeoutTimer;
    let terminationTimer;

    const settleReject = error => {
      if (responseSettled) return;
      responseSettled = true;
      reject(error);
    };
    const settleResolve = value => {
      if (responseSettled) return;
      responseSettled = true;
      resolve(value);
    };
    const startTerminationGrace = () => {
      if (terminationTimer || closed) return;
      terminationTimer = setTimeout(() => {
        if (!closed) {
          clearTimeout(timeoutTimer);
          settleReject(terminationFailure());
        }
      }, readerTerminationGrace(timeoutMs));
    };

    const terminate = error => {
      if (terminalError || closed) return;
      terminalError = error;
      try {
        child.kill();
      } catch {
        // The grace timer reports only that termination could not be confirmed.
      }
      startTerminationGrace();
    };

    const finalize = async code => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      clearTimeout(timeoutTimer);
      clearTimeout(terminationTimer);
      try {
        await cleanupReaderRequestDirectory(request);
      } catch {
        settleReject(fail('LOCAL_READER_CLEANUP_FAILED'));
        return;
      }
      if (responseSettled) return;
      if (terminalError) {
        settleReject(terminalError);
      } else {
        settleResolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
      }
    };

    child.once('error', () => terminate(fail('LOCAL_READER_UNAVAILABLE')));
    child.stdin.once('error', () => terminate(fail('LOCAL_READER_UNAVAILABLE')));
    child.stdout.once('error', () => terminate(fail('LOCAL_READER_UNAVAILABLE')));
    child.stderr.once('error', () => terminate(fail('LOCAL_READER_UNAVAILABLE')));
    child.stdout.on('data', chunk => {
      if (terminalError || closed) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) terminate(fail('LOCAL_READER_RESULT_TOO_LARGE'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {}); // Never forward process/key/SQLite exception text.
    child.once('close', code => {
      closed = true;
      void finalize(code);
    });
    timeoutTimer = setTimeout(() => terminate(fail('LOCAL_READER_TIMEOUT')), timeoutMs);
    try {
      child.stdin.end(JSON.stringify(scope));
    } catch {
      terminate(fail('LOCAL_READER_UNAVAILABLE'));
    }
  });
}

function readerTerminationGrace(timeoutMs) {
  return Math.min(MAX_TERMINATION_GRACE_MS, Math.max(MIN_TERMINATION_GRACE_MS, timeoutMs));
}

function awaitMalformedReaderChild(child, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let closed = false;
    let cleanupStarted = false;
    let settled = false;
    const settleReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finishAfterClose = async () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      clearTimeout(terminationTimer);
      try {
        await cleanupReaderRequestDirectory(request);
      } catch {
        settleReject(fail('LOCAL_READER_CLEANUP_FAILED'));
        return;
      }
      if (!settled) settleReject(fail('LOCAL_READER_UNAVAILABLE'));
    };
    const terminationTimer = setTimeout(() => {
      if (!closed) settleReject(terminationFailure());
    }, readerTerminationGrace(timeoutMs));

    try {
      child.once('close', () => {
        closed = true;
        void finishAfterClose();
      });
      child.kill();
    } catch {
      // Do not delete an owned directory while an injected child might be live.
    }
  });
}

async function cleanupAfterReaderFailure(request, error) {
  try {
    await cleanupReaderRequestDirectory(request);
  } catch {
    throw fail('LOCAL_READER_CLEANUP_FAILED');
  }
  throw error;
}

async function createReaderRequestDirectory() {
  const localAppData = readerLocalAppDataDirectory();
  await assertSafeDirectoryComponents(localAppData);
  const applicationDirectory = await ensureSafeDirectoryChild(localAppData, 'line-desktop-mcp');
  const readerDirectory = await ensureSafeDirectoryChild(applicationDirectory, 'line-reader');
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomUUID().replaceAll('-', '');
    if (!/^[0-9a-f]{32}$/u.test(id)) throw fail('LOCAL_READER_UNAVAILABLE');
    const directory = path.join(readerDirectory, `line-reader-${id}`);
    await assertSafeDirectory(readerDirectory);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw fail('LOCAL_READER_UNAVAILABLE');
    }
    await assertSafeDirectory(directory);
    return { id, directory };
  }
  throw fail('LOCAL_READER_UNAVAILABLE');
}

function readerLocalAppDataDirectory() {
  const value = process.env.LOCALAPPDATA;
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0') || !path.isAbsolute(value)) {
    throw fail('LOCAL_READER_UNAVAILABLE');
  }
  const parsed = path.parse(value);
  const suffix = value.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  if (!parsed.root || suffix.some(part => part === '.' || part === '..')) throw fail('LOCAL_READER_UNAVAILABLE');
  return path.normalize(value);
}

function directoryComponents(directory) {
  const parsed = path.parse(directory);
  if (!parsed.root || !path.isAbsolute(directory)) throw fail('LOCAL_READER_UNAVAILABLE');
  const components = [parsed.root];
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean)) {
    if (part === '.' || part === '..') throw fail('LOCAL_READER_UNAVAILABLE');
    current = path.join(current, part);
    components.push(current);
  }
  return components;
}

async function assertSafeDirectoryComponents(directory) {
  for (const component of directoryComponents(directory)) await assertSafeDirectory(component);
}

async function ensureSafeDirectoryChild(parent, name) {
  await assertSafeDirectory(parent);
  const directory = path.join(parent, name);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw fail('LOCAL_READER_UNAVAILABLE');
  }
  await assertSafeDirectory(directory);
  return directory;
}

async function assertSafeDirectory(directory) {
  let info;
  try { info = await fs.lstat(directory); }
  catch { throw fail('LOCAL_READER_UNAVAILABLE'); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('LOCAL_READER_UNAVAILABLE');
}

async function cleanupReaderRequestDirectory(request) {
  if (!isOwnedReaderDirectory(request)) throw fail('LOCAL_READER_CLEANUP_FAILED');
  let directoryInfo;
  try { directoryInfo = await fs.lstat(request.directory); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw fail('LOCAL_READER_CLEANUP_FAILED');
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw fail('LOCAL_READER_CLEANUP_FAILED');

  try {
    await assertSafeDirectoryComponents(request.directory);
    const names = await fs.readdir(request.directory);
    if (names.some(name => !FIXED_SNAPSHOT_FILES.includes(name))) throw new Error('unexpected reader file');
    for (const name of FIXED_SNAPSHOT_FILES) await assertSafeSnapshotFile(path.join(request.directory, name));
    for (const name of FIXED_SNAPSHOT_FILES) {
      const target = path.join(request.directory, name);
      await assertSafeSnapshotFile(target);
      try { await fs.unlink(target); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    await fs.rmdir(request.directory);
  } catch {
    throw fail('LOCAL_READER_CLEANUP_FAILED');
  }
}

function isOwnedReaderDirectory(request) {
  if (!request || typeof request.directory !== 'string' || !/^[0-9a-f]{32}$/u.test(request.id ?? '')) return false;
  const name = `line-reader-${request.id}`;
  const parent = path.dirname(request.directory);
  return path.basename(request.directory) === name
    && path.basename(parent) === 'line-reader'
    && path.basename(path.dirname(parent)) === 'line-desktop-mcp';
}

async function assertSafeSnapshotFile(target) {
  let info;
  try { info = await fs.lstat(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe snapshot file');
}

export async function readKeepOpenIdentity({ runProcess = runReaderProcess } = {}) {
  const output = await runProcess({ mode: 'keepOpenIdentity' });
  let result;
  try {
    if (typeof output?.stdout !== 'string' || Buffer.byteLength(output.stdout) > MAX_OUTPUT) throw new Error();
    result = JSON.parse(output.stdout);
  } catch { throw fail('LOCAL_READER_INVALID_RESULT'); }
  if (output.code !== 0 || result?.ok !== true) {
    throw fail(['CHAT_NOT_FOUND', 'CHAT_AMBIGUOUS'].includes(result?.code) ? result.code : 'LOCAL_READER_FAILED');
  }
  const keys = Object.keys(result).filter(key => !['retrievedAt', 'freshness', 'readerTiming'].includes(key)).sort().join(',');
  if (keys !== 'mode,ok' || result.mode !== 'keepOpenIdentity'
      || result.freshness?.clockOrderValid !== true || result.freshness?.capturedAfterInitialization !== true) {
    throw fail('LOCAL_READER_INVALID_RESULT');
  }
  return true;
}

export async function readLocalLineChatIdentity(args, options = {}) {
  validateLocalScope(args);
  return readLocalLineMessages({ ...args, identityOnly: true }, { ...options, allowIdentityOnly: true });
}

/** Private ref-bound existing-chat lookup. Never exposed as an arbitrary public read flag. */
export function readLocalLineBoundDirectMessages(args, options = {}) {
  return readLocalLineMessages({ ...args, boundDirect: true }, { ...options, allowBoundDirect: true });
}

export function readLocalLineBoundDirectIdentity(args, options = {}) {
  return readLocalLineMessages({ ...args, boundDirect: true, identityOnly: true },
    { ...options, allowBoundDirect: true, allowIdentityOnly: true });
}

export async function readLocalLineGuiChatIdentity(args, options = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'chatName')) throw fail('LINE_INVALID_ARGUMENT');
  requireChat(args.chatName);
  if (/[\x00-\x1f]/u.test(args.chatName)) throw fail('LINE_INVALID_ARGUMENT');
  const { now = () => new Date(), ...readerOptions } = options;
  let instant;
  try { instant = now(); } catch { throw fail('LINE_INVALID_ARGUMENT'); }
  if (!(instant instanceof Date) || !Number.isFinite(instant.valueOf())) throw fail('LINE_INVALID_ARGUMENT');
  const date = new Date(instant.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return readLocalLineMessages({ chatName: args.chatName, dateFrom: date, dateTo: date,
    identityOnly: true, guiIdentityOnly: true }, {
    ...readerOptions, allowIdentityOnly: true, allowGuiIdentityOnly: true,
  });
}

export async function readLocalLineGuiCandidateIdentity(args, options = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'chatName')) throw fail('LINE_INVALID_ARGUMENT');
  requireChat(args.chatName);
  if (/\p{Cc}/u.test(args.chatName)) throw fail('LINE_INVALID_ARGUMENT');
  const { now = () => new Date(), ...readerOptions } = options;
  let instant;
  try { instant = now(); } catch { throw fail('LINE_INVALID_ARGUMENT'); }
  if (!(instant instanceof Date) || !Number.isFinite(instant.valueOf())) throw fail('LINE_INVALID_ARGUMENT');
  const date = new Date(instant.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await readLocalLineMessages({ chatName: args.chatName, chatType: 'direct',
    dateFrom: date, dateTo: date, identityOnly: true, guiCandidateOnly: true }, {
    ...readerOptions, allowIdentityOnly: true, allowGuiCandidateOnly: true,
  });
  // Candidate evidence is intentionally smaller than the local reader result.
  return { ok: true, chatName: result.chatName, chatRef: result.chatRef,
    chatIdentity: result.chatIdentity, count: 0, messages: [],
    scope: { kind: 'local_gui_candidate_identity', requested: result.scope.requested,
      truncated: false } };
}

export async function readLocalLineGuiGroupCandidateIdentity(args, options = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'chatName')) throw fail('LINE_INVALID_ARGUMENT');
  requireChat(args.chatName);
  if (/\p{Cc}/u.test(args.chatName)) throw fail('LINE_INVALID_ARGUMENT');
  const { now = () => new Date(), ...readerOptions } = options;
  let instant;
  try { instant = now(); } catch { throw fail('LINE_INVALID_ARGUMENT'); }
  if (!(instant instanceof Date) || !Number.isFinite(instant.valueOf())) throw fail('LINE_INVALID_ARGUMENT');
  const date = new Date(instant.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await readLocalLineMessages({ chatName: args.chatName, chatType: 'group',
    dateFrom: date, dateTo: date, identityOnly: true, groupCandidateOnly: true }, {
    ...readerOptions, allowIdentityOnly: true, allowGroupCandidateOnly: true,
  });
  return { ok: true, chatName: result.chatName, chatRef: result.chatRef,
    chatIdentity: result.chatIdentity, count: 0, messages: [],
    scope: { kind: 'local_gui_group_candidate_identity', requested: result.scope.requested,
      truncated: false } };
}

export async function readLocalLineMessages(args, { runProcess = runReaderProcess, allowIdentityOnly = false,
  allowGuiIdentityOnly = false, allowGuiCandidateOnly = false, allowGroupCandidateOnly = false, allowBoundDirect = false } = {}) {
  const scope = validateLocalScope(args, { allowIdentityOnly, allowGuiIdentityOnly,
    allowGuiCandidateOnly, allowGroupCandidateOnly, allowBoundDirect });
  let output;
  try { output = await runProcess(scope); }
  catch (error) { throw error instanceof LineToolError ? error : fail('LOCAL_READER_UNAVAILABLE'); }
  if (typeof output?.stdout !== 'string' || Buffer.byteLength(output.stdout) > MAX_OUTPUT) throw fail('LOCAL_READER_INVALID_RESULT');
  let result;
  try { result = JSON.parse(output.stdout); } catch { throw fail('LOCAL_READER_INVALID_RESULT'); }
  const allowedErrors = new Set(['CHAT_NOT_FOUND', 'CHAT_AMBIGUOUS', 'CHAT_IDENTITY_CHANGED', 'CHAT_ACCOUNT_CHANGED', 'CHAT_TYPE_MISMATCH',
    'GUI_IDENTITY_UNAVAILABLE', 'GUI_IDENTITY_NAME_TYPE', 'GUI_IDENTITY_NAME_EMPTY', 'GUI_IDENTITY_NAME_TOO_LONG',
    'GUI_IDENTITY_NAME_CONTROL', 'GUI_IDENTITY_NAME_NORMALIZATION', 'GUI_IDENTITY_GROUP_NAME_NULL',
    'GUI_IDENTITY_DIRECT_NAME_NULL', 'GUI_IDENTITY_ID_INVALID',
    'GUI_IDENTITY_QUERY_RESULT_TOO_LARGE',
    'GUI_IDENTITY_QUERY_DATABASE_READ_FAILED', 'GUI_IDENTITY_QUERY_FAILED',
    'GUI_IDENTITY_ROW_INVALID', 'GUI_IDENTITY_INVENTORY_LIMIT', 'GUI_IDENTITY_CONFLICT',
    'SOURCE_BUSY', 'SESSION_KEY_UNAVAILABLE',
    'LINE_BUILD_UNVERIFIED',
    'SESSION_KEY_CHANGED', 'DATABASE_READ_FAILED', 'RESULT_TOO_LARGE', 'INVALID_CURSOR', 'CURSOR_SCOPE_MISMATCH',
    'MAIN_DATABASE_AMBIGUOUS', 'LINE_PROCESS_UNAVAILABLE', 'LINE_PROCESS_AMBIGUOUS', 'ENGINE_INTEGRITY_FAILED',
    'ENGINE_CIPHER_UNAVAILABLE', 'ENGINE_DLL_UNCONFIGURED', 'ENGINE_DLL_INVALID_PATH', 'ENGINE_DLL_UNAVAILABLE',
    'RUNTIME_DIRECTORY_UNAVAILABLE',
    'SOURCE_IO_ERROR', 'SOURCE_NOT_READONLY', 'INVALID_SOURCE_TIME', 'INVALID_SOURCE_ID',
    'SOURCE_ACCESS_DENIED', 'SOURCE_NOT_FOUND', 'SOURCE_REPARSE', 'SOURCE_NOT_FILE', 'SOURCE_TOO_LARGE', 'INVALID_PATH',
    'SOURCE_LIMIT_INVALID', 'SNAPSHOT_DESTINATION_EXISTS', 'SNAPSHOT_DISK_FULL', 'SNAPSHOT_IO_ERROR', 'SNAPSHOT_CLEANUP_FAILED',
    'DATABASE_HEADER_INVALID', 'DATABASE_SIZE_INVALID', 'WAL_HEADER_INVALID', 'WAL_PAGE_SIZE_MISMATCH', 'WAL_NO_VALID_COMMIT']);
  if (!result || typeof result !== 'object' || output.code !== 0 || result.ok !== true) {
    const sourceLimitError = result?.code === 'SOURCE_TOO_LARGE' ? safeSourceLimitError(result) : null;
    if (result?.code === 'SOURCE_TOO_LARGE') throw sourceLimitError ?? fail('LOCAL_READER_FAILED');
    throw fail(allowedErrors.has(result?.code) ? result.code : 'LOCAL_READER_FAILED');
  }
  const expectedKind = scope.groupCandidateOnly ? 'local_gui_group_candidate_identity'
    : scope.guiCandidateOnly ? 'local_gui_candidate_identity'
    : scope.guiIdentityOnly ? 'local_gui_chat_identity'
    : scope.identityOnly ? 'local_chat_identity' : 'local_database';
  const guiShapeMatches = !scope.guiIdentityOnly || (
    result.chatIdentity && typeof result.chatIdentity === 'object' && !Array.isArray(result.chatIdentity)
    && Object.keys(result.chatIdentity).sort().join(',') === 'displayName,guiDisplayNameUnique,kind,uiIdentityVerified'
    && result.scope?.requested && typeof result.scope.requested === 'object' && !Array.isArray(result.scope.requested)
    && Object.keys(result.scope.requested).sort().join(',') === Object.keys(scope).sort().join(','));
  const candidateShapeMatches = !scope.guiCandidateOnly || (
    result.chatIdentity && typeof result.chatIdentity === 'object' && !Array.isArray(result.chatIdentity)
    && Object.keys(result.chatIdentity).sort().join(',') === 'displayName,guiDisplayNameUnique,kind,knownNameUnique,uiIdentityVerified,unresolvedNameCount'
    && result.chatIdentity.kind === 'direct'
    && result.chatIdentity.guiDisplayNameUnique === false
    && result.chatIdentity.knownNameUnique === true
    && Number.isSafeInteger(result.chatIdentity.unresolvedNameCount)
    && result.chatIdentity.unresolvedNameCount >= 0 && result.chatIdentity.unresolvedNameCount <= 10000
    && result.scope?.requested && typeof result.scope.requested === 'object' && !Array.isArray(result.scope.requested)
    && Object.keys(result.scope.requested).sort().join(',') === Object.keys(scope).sort().join(','));
  const groupCandidateShapeMatches = !scope.groupCandidateOnly || (
    result.chatIdentity && typeof result.chatIdentity === 'object' && !Array.isArray(result.chatIdentity)
    && Object.keys(result.chatIdentity).sort().join(',') === 'displayName,guiDisplayNameUnique,kind,knownNameUnique,uiIdentityVerified'
    && result.chatIdentity.kind === 'group'
    && result.chatIdentity.guiDisplayNameUnique === false
    && result.chatIdentity.knownNameUnique === true
    && result.scope?.requested && typeof result.scope.requested === 'object' && !Array.isArray(result.scope.requested)
    && Object.keys(result.scope.requested).sort().join(',') === Object.keys(scope).sort().join(','));
  if (result.chatName !== scope.chatName || result.scope?.kind !== expectedKind
      || (scope.expectedChatRef !== undefined && result.chatRef !== scope.expectedChatRef)
      || (scope.expectedOwnSenderRef !== undefined && result.ownSenderRef !== scope.expectedOwnSenderRef)
      || !guiShapeMatches || !candidateShapeMatches || !groupCandidateShapeMatches
      || result.scope?.requested?.identityOnly !== scope.identityOnly
      || result.scope?.requested?.guiIdentityOnly !== scope.guiIdentityOnly
      || result.scope?.requested?.guiCandidateOnly !== scope.guiCandidateOnly
      || result.scope?.requested?.groupCandidateOnly !== scope.groupCandidateOnly
      || result.scope?.requested?.expectedChatRef !== scope.expectedChatRef
      || result.scope?.requested?.expectedOwnSenderRef !== scope.expectedOwnSenderRef
      || result.scope?.requested?.boundDirect !== scope.boundDirect
      || (scope.boundDirect && (result.chatIdentity?.kind !== 'direct'
        || result.chatIdentity.knownNameUnique !== true || result.chatIdentity.guiDisplayNameUnique !== false
        || typeof result.chatIdentity.globalNameUnique !== 'boolean'))
      || (scope.identityOnly && (result.count !== 0 || result.scope.truncated !== false || !/^chat:[0-9a-f]{24}$/u.test(result.chatRef ?? '')))
      || (result.chatIdentity?.kind === 'group' && !scope.identityOnly
        && result.ownSenderRef !== null && !/^sender:[0-9a-f]{24}$/u.test(result.ownSenderRef ?? ''))
      || !['direct', 'group'].includes(result.chatIdentity?.kind)
      || result.chatIdentity?.displayName !== scope.chatName || result.chatIdentity?.uiIdentityVerified !== false
      || (scope.guiIdentityOnly && result.chatIdentity?.guiDisplayNameUnique !== true)
      || (scope.chatType && scope.chatType !== 'auto' && result.chatIdentity.kind !== scope.chatType)
      || result.scope?.requested?.chatName !== scope.chatName
      || result.scope?.requested?.chatType !== scope.chatType
      || result.scope?.requested?.dateFrom !== scope.dateFrom || result.scope?.requested?.dateTo !== scope.dateTo
       || result.scope?.requested?.messageLimit !== scope.messageLimit || result.scope?.requested?.query !== scope.query
       || result.scope?.requested?.cursor !== scope.cursor || result.scope?.requested?.mediaMode !== scope.mediaMode
       || JSON.stringify(result.scope?.requested?.mediaSourceRefs) !== JSON.stringify(scope.mediaSourceRefs)
      || !Array.isArray(result.messages) || !Number.isInteger(result.count) || result.count < 0
      || result.count !== result.messages.length || result.count > scope.messageLimit
      || result.messages.some(message => !message || typeof message !== 'object'
        || typeof message.sourceRef !== 'string' || typeof message.date !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/u.test(message.date) || message.date < scope.dateFrom || message.date > scope.dateTo
        || !Number.isSafeInteger(message.sourceTimestamp)
        || new Date(message.sourceTimestamp + 28800000).toISOString().slice(0, 10) !== message.date
       || (scope.query !== undefined && (typeof message.text !== 'string' || !message.text.includes(scope.query))))) throw fail('LOCAL_READER_SCOPE_MISMATCH');
  if (!result.pagination || typeof result.pagination !== 'object' || Array.isArray(result.pagination)) throw fail('LOCAL_READER_INVALID_RESULT');
  {
    if (typeof result.pagination.hasMore !== 'boolean' || result.pagination.hasMore !== result.scope.truncated
        || (result.pagination.hasMore && (!result.messages.length || typeof result.pagination.nextCursor !== 'string'))
        || (!result.pagination.hasMore && result.pagination.nextCursor !== null)) throw fail('LOCAL_READER_INVALID_RESULT');
    if (result.pagination.nextCursor !== null) {
      const next = validateCursor(result.pagination.nextCursor, scope);
      const oldest = result.messages[0];
      if (next.chat !== result.chatRef || next.time !== oldest.sourceTimestamp || String(next.id) !== oldest.sourceMessageId) throw fail('LOCAL_READER_INVALID_RESULT');
    }
  }
  return result;
}

export async function readLocalLineChatCandidates(args, { runProcess = runReaderProcess } = {}) {
  const scope = validateCandidateScope(args);
  const output = await runProcess(scope);
  let result;
  try {
    if (typeof output?.stdout !== 'string' || Buffer.byteLength(output.stdout) > MAX_OUTPUT) throw new Error();
    result = JSON.parse(output.stdout);
  } catch { throw fail('LOCAL_READER_INVALID_RESULT'); }
  if (output.code !== 0 || result?.ok !== true) {
    const allowed = new Set(['GUI_IDENTITY_ROW_INVALID', 'GUI_IDENTITY_CONFLICT', 'LINE_BUILD_UNVERIFIED',
      'SOURCE_BUSY', 'SESSION_KEY_UNAVAILABLE', 'SESSION_KEY_CHANGED', 'DATABASE_READ_FAILED', 'SOURCE_TOO_LARGE',
      'LINE_PROCESS_UNAVAILABLE', 'MAIN_DATABASE_AMBIGUOUS', 'SNAPSHOT_CLEANUP_FAILED']);
    throw fail(allowed.has(result?.code) ? result.code : 'LOCAL_READER_FAILED');
  }
  if (result.chatName !== scope.chatName || result.scope?.kind !== 'local_chat_candidates'
      || !result.scope.requested || Object.keys(result.scope.requested).sort().join(',') !== 'chatName,limit,mode'
      || result.scope.requested.mode !== scope.mode || result.scope.requested.chatName !== scope.chatName
      || result.scope.requested.limit !== scope.limit
      || (result.ownSenderRef !== null && !/^sender:[0-9a-f]{24}$/u.test(result.ownSenderRef ?? ''))
      || typeof result.hasMore !== 'boolean' || !Array.isArray(result.candidates)
      || result.candidates.length > scope.limit
      || new Set(result.candidates.map(item => item?.chatRef)).size !== result.candidates.length
      || result.candidates.some(item => !item || Object.keys(item).sort().join(',') !== 'chatName,chatRef,chatType,existingChat'
        || item.chatName !== scope.chatName || !/^chat:[0-9a-f]{24}$/u.test(item.chatRef ?? '')
        || !['direct', 'group'].includes(item.chatType) || typeof item.existingChat !== 'boolean'
        || (item.chatType === 'group' && item.existingChat !== true))) throw fail('LOCAL_READER_SCOPE_MISMATCH');
  // Return only validated identity metadata, never arbitrary reader fields.
  return { ok: true, chatName: scope.chatName, ownSenderRef: result.ownSenderRef,
    candidates: result.candidates, hasMore: result.hasMore, scope: result.scope,
    ...(typeof result.retrievedAt==='string' && Number.isFinite(Date.parse(result.retrievedAt))
      ? {retrievedAt:result.retrievedAt}:{}) };
}

export async function readLocalLineRecentChats(args, { runProcess = runReaderProcess } = {}) {
  const scope = validateRecentScope(args);
  let output;
  try { output = await runProcess(scope); }
  catch (error) { throw error instanceof LineToolError ? error : fail('LOCAL_READER_UNAVAILABLE'); }
  if (typeof output?.stdout !== 'string' || Buffer.byteLength(output.stdout) > MAX_OUTPUT) throw fail('LOCAL_READER_INVALID_RESULT');
  let result;
  try { result = JSON.parse(output.stdout); } catch { throw fail('LOCAL_READER_INVALID_RESULT'); }
  if (output.code !== 0 || result?.ok !== true) {
    const allowed = new Set(['RECENT_SCOPE_TOO_LARGE', 'RECENT_ROW_INVALID', 'SOURCE_BUSY',
      'LINE_BUILD_UNVERIFIED', 'SESSION_KEY_UNAVAILABLE', 'SESSION_KEY_CHANGED',
      'DATABASE_READ_FAILED', 'RESULT_TOO_LARGE', 'MAIN_DATABASE_AMBIGUOUS',
      'LINE_PROCESS_UNAVAILABLE', 'LINE_PROCESS_AMBIGUOUS', 'ENGINE_INTEGRITY_FAILED',
      'ENGINE_CIPHER_UNAVAILABLE', 'ENGINE_DLL_UNCONFIGURED', 'ENGINE_DLL_INVALID_PATH',
      'ENGINE_DLL_UNAVAILABLE', 'RUNTIME_DIRECTORY_UNAVAILABLE', 'SOURCE_IO_ERROR',
      'SOURCE_NOT_READONLY', 'SOURCE_ACCESS_DENIED', 'SOURCE_NOT_FOUND', 'SOURCE_REPARSE',
      'SOURCE_NOT_FILE', 'SOURCE_TOO_LARGE', 'INVALID_PATH', 'SOURCE_LIMIT_INVALID',
      'SNAPSHOT_DESTINATION_EXISTS', 'SNAPSHOT_DISK_FULL', 'SNAPSHOT_IO_ERROR',
      'SNAPSHOT_CLEANUP_FAILED', 'DATABASE_HEADER_INVALID', 'DATABASE_SIZE_INVALID',
      'WAL_HEADER_INVALID', 'WAL_PAGE_SIZE_MISMATCH', 'WAL_NO_VALID_COMMIT']);
    throw fail(allowed.has(result?.code) ? result.code : 'LOCAL_READER_FAILED');
  }
  const keys = Object.keys(result).filter(key => !['retrievedAt', 'freshness', 'readerTiming'].includes(key)).sort().join(',');
  const expectedKeys = 'chats,checkedAt,dateFrom,dateTo,days,hasMore,ok,ownSenderRef,warnings';
  const checked = Date.parse(result.checkedAt);
  const taipeiDate = Number.isFinite(checked) ? new Date(checked + 28800000).toISOString().slice(0, 10) : null;
  const firstDate = taipeiDate ? new Date(Date.parse(taipeiDate) - (scope.days - 1) * 86400000).toISOString().slice(0, 10) : null;
  const chats = result.chats;
  const warningPatterns = [
    /^[1-9][0-9]{0,3} recent chat identities had no valid resolvable name and were excluded\.$/u,
    /^[1-9][0-9]{0,3} recent chat identities had conflicting records and were excluded\.$/u,
  ];
  if (keys !== expectedKeys || result.days !== scope.days || result.dateFrom !== firstDate
      || result.dateTo !== taipeiDate || !/^\d{4}-\d{2}-\d{2}T.*\+08:00$/u.test(result.checkedAt ?? '')
      || (result.ownSenderRef !== null && !/^sender:[0-9a-f]{24}$/u.test(result.ownSenderRef ?? ''))
      || !Array.isArray(chats) || chats.length > scope.limit || !Array.isArray(result.warnings)
      || result.warnings.length > 2 || result.warnings.some((warning, index) =>
        typeof warning !== 'string' || !(index === 0
          ? warningPatterns.some(pattern => pattern.test(warning))
          : warningPatterns[0].test(result.warnings[0]) && warningPatterns[1].test(warning)))
      || typeof result.hasMore !== 'boolean' || (result.hasMore && chats.length !== scope.limit)) {
    throw fail('LOCAL_READER_SCOPE_MISMATCH');
  }
  const refs = new Set();
  for (const [index, chat] of chats.entries()) {
    const lastAt = typeof chat?.lastMessageAt === 'string' ? Date.parse(chat.lastMessageAt) : NaN;
    const localMoment = Number.isSafeInteger(chat?.lastMessageTimestamp)
      ? new Date(chat.lastMessageTimestamp + 28800000) : null;
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)
        || Object.keys(chat).sort().join(',') !== 'chatName,chatRef,chatType,lastMessageAt,lastMessageTimestamp'
        || !/^chat:[0-9a-f]{24}$/u.test(chat.chatRef ?? '') || refs.has(chat.chatRef)
        || typeof chat.chatName !== 'string' || !chat.chatName || chat.chatName.length > 200
        || chat.chatName !== chat.chatName.trim() || /\p{Cc}/u.test(chat.chatName)
        || !['direct', 'group'].includes(chat.chatType)
        || !Number.isSafeInteger(chat.lastMessageTimestamp)
        || chat.lastMessageTimestamp > checked
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/u.test(chat.lastMessageAt ?? '')
        || lastAt !== chat.lastMessageTimestamp || !Number.isFinite(localMoment?.valueOf())
        || (index > 0 && chats[index - 1].lastMessageTimestamp < chat.lastMessageTimestamp)) {
      throw fail('LOCAL_READER_SCOPE_MISMATCH');
    }
    const localDate = localMoment.toISOString().slice(0, 10);
    if (localDate < result.dateFrom || localDate > result.dateTo) throw fail('LOCAL_READER_SCOPE_MISMATCH');
    refs.add(chat.chatRef);
  }
  return { ok: true, days: result.days, dateFrom: result.dateFrom, dateTo: result.dateTo,
    checkedAt: result.checkedAt, ownSenderRef: result.ownSenderRef, chats, hasMore: result.hasMore,
    warnings: result.warnings };
}

function safeSourceLimitError(result) {
  const details = result?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)
      || Object.keys(details).sort().join(',') !== 'maxBytes,setting,sourceBytes,sourceKind') return null;
  const limit = SOURCE_LIMITS[details.sourceKind];
  if (!limit || details.setting !== limit.setting
      || !Number.isSafeInteger(details.sourceBytes) || details.sourceBytes < 0
      || !Number.isSafeInteger(details.maxBytes) || details.maxBytes < 0
      || details.sourceBytes <= details.maxBytes
      || details.maxBytes !== configuredSourceLimit(limit)) return null;
  return new LineToolError('SOURCE_TOO_LARGE',
    'A local LINE source exceeded its configured safe size limit. No GUI fallback or send was attempted.', {
      sourceKind: details.sourceKind,
      sourceBytes: details.sourceBytes,
      maxBytes: details.maxBytes,
      setting: details.setting,
    });
}

function configuredSourceLimit(limit) {
  const raw = process.env[limit.setting];
  if (raw === undefined) return limit.defaultMaxBytes;
  if (typeof raw !== 'string' || !/^[0-9]+$/u.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > limit.maxConfiguredBytes) return null;
  return value;
}
