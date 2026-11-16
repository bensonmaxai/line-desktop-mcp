import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { callCuaTool, createCuaInputValidator, closeCuaSession, hasMainLineShell, mainLineWindow, requireConfiguredCuaDriver, snapshot, withCuaClient } from '../src/extensions/cua-line-client.mjs';
import { configuredCuaDriverPath, runtimeRequire } from '../src/extensions/line-runtime.mjs';

// These have the same { name, inputSchema } shape supplied by MCP listTools.
// set_value is AX-only in the current driver, while press_key accepts the
// documented singular `key: 'return'` and delivery mode.
const RUNTIME_TOOL_DESCRIPTORS = [
  {
    name: 'set_value',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pid', 'element_token', 'value'],
      properties: {
        pid: { type: 'integer', minimum: 0 },
        window_id: { type: 'integer', minimum: 0 },
        element_token: { type: 'string', minLength: 1 },
        value: { type: 'string' },
      },
    },
  },
  {
    name: 'press_key',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pid', 'key'],
      properties: {
        pid: { type: 'integer', minimum: 0 },
        window_id: { type: 'integer', minimum: 0 },
        element_token: { type: 'string', minLength: 1 },
        key: { type: 'string', minLength: 1 },
        delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
      },
    },
  },
];

const [observedMain, observedAux] = JSON.parse(fs.readFileSync(
  new URL('./fixtures/live-window-structure-20260928.json', import.meta.url), 'utf8'));
const observedV2 = JSON.parse(fs.readFileSync(
  new URL('./fixtures/live-window-structure-v2-20260928.json', import.meta.url), 'utf8'));
const liveMain = observedV2.find(row => row.window.window_id === 68616);
const liveAux = observedV2.find(row => row.window.window_id !== 68616);
const minimizedMain = JSON.parse(fs.readFileSync(
  new URL('./fixtures/minimized-window-structure-20260928.json', import.meta.url), 'utf8'))[0];
const sameSizedPopup = {
  window: { ...observedMain.window, window_id: 90001 },
  elements: [
    { element_index: 0, role: 'Window', frame: { ...observedMain.elements[0].frame } },
    { element_index: 1, parent_index: 0, role: 'Group', frame: { x: 1112, y: 91, w: 302, h: 1269 } },
    { element_index: 2, parent_index: 1, role: 'Edit', frame: { x: 1124, y: 103, w: 244, h: 38 } },
    { element_index: 3, parent_index: 1, role: 'List', frame: { x: 1112, y: 149, w: 302, h: 1131 } },
  ],
  stateMeta: { elements_complete:true, total_element_count:4 },
};

function windowApi(rows) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push({ name, args });
    if (name === 'list_windows') return { windows: rows.map(row => row.window) };
    if (name === 'get_window_state') {
      const row = rows.find(item => item.window.window_id === args.window_id);
      assert.ok(row, 'only listed windows may be inspected');
      assert.equal(args.include_screenshot, false);
      return { elements: row.elements, ...row.stateMeta };
    }
    assert.fail(`unexpected UI input: ${name}`);
  } };
}

test('sanitized live shell distinguishes empty main window from same-title auxiliary windows', async () => {
  assert.equal(liveMain.stateMeta.elements_complete, false);
  assert.equal(hasMainLineShell(liveMain.window,
    { elements: liveMain.elements, ...liveMain.stateMeta }), true);
  assert.equal(hasMainLineShell(liveAux.window,
    { elements: liveAux.elements, ...liveAux.stateMeta }), false);
  assert.equal(minimizedMain.window.minimized, true);
  assert.equal(hasMainLineShell(minimizedMain.window,
    { elements: minimizedMain.elements, ...minimizedMain.stateMeta }), true);
  assert.equal(hasMainLineShell(sameSizedPopup.window, { elements: sameSizedPopup.elements }), false);
  const ghost = { window: { ...observedAux.window, window_id: 90002 }, elements: [] };
  const api = windowApi([liveAux, ghost, liveMain, sameSizedPopup]);
  assert.equal((await mainLineWindow(api)).window_id, liveMain.window.window_id);
  assert.ok(api.calls.every(call => ['list_windows', 'get_window_state'].includes(call.name)));
  assert.equal((await mainLineWindow(windowApi([liveAux, minimizedMain]))).window_id,
    minimizedMain.window.window_id);
});

test('selection refuses zero, two, incomplete or wrong main shells without input', async () => {
  const secondMain = { window: { ...liveMain.window, window_id: 90003 },
    elements: liveMain.elements, stateMeta:liveMain.stateMeta };
  for (const [rows, count] of [
    [[liveAux, sameSizedPopup], 0],
    [[sameSizedPopup], 0],
    [[liveMain, secondMain], 2],
  ]) {
    const api = windowApi(rows);
    await assert.rejects(mainLineWindow(api), error =>
      error?.code === 'LINE_TARGET_NOT_UNIQUE' && error.details.candidateCount === count);
    assert.ok(api.calls.every(call => ['list_windows', 'get_window_state'].includes(call.name)));
  }
  const incompletePopup = { ...sameSizedPopup,
    stateMeta:{ elements_complete:false, total_element_count:sameSizedPopup.elements.length } };
  const api = windowApi([liveMain, incompletePopup]);
  await assert.rejects(mainLineWindow(api), error => error?.code === 'LINE_TARGET_NOT_UNIQUE'
    && error.details.candidateCount === 1 && error.details.inconclusiveCount === 1);
});

function countedAjv() {
  const Ajv = runtimeRequire()('ajv');
  const realAjv = new Ajv({ strict: false, allErrors: true });
  let compileCount = 0;
  return {
    ajv: {
      compile(schema) {
        compileCount += 1;
        return realAjv.compile(schema);
      },
    },
    compileCount: () => compileCount,
  };
}

test('requires an explicit absolute regular CUA executable only at the UI boundary', () => {
  const driverPath = path.resolve('test-fixtures', 'cua-driver.exe');
  assert.equal(configuredCuaDriverPath(''), null);
  assert.equal(configuredCuaDriverPath('cua-driver.exe'), null);
  assert.equal(configuredCuaDriverPath(path.resolve('test-fixtures', 'cua-driver.txt')), null);
  assert.equal(configuredCuaDriverPath(` ${driverPath}`), null);
  assert.equal(configuredCuaDriverPath(driverPath), driverPath);

  assert.throws(
    () => requireConfiguredCuaDriver({ configuredPath: null }),
    error => error?.code === 'LINE_UI_BACKEND_UNAVAILABLE' && error.operationMayHaveCompleted === false,
  );
  assert.throws(
    () => requireConfiguredCuaDriver({
      configuredPath: driverPath,
      fileSystem: { statSync: () => ({ isFile: () => false }) },
    }),
    { code: 'LINE_UI_BACKEND_UNAVAILABLE' },
  );
  assert.equal(
    requireConfiguredCuaDriver({
      configuredPath: driverPath,
      fileSystem: { statSync: () => ({ isFile: () => true }) },
    }),
    driverPath,
  );
});

test('a missing CUA configuration refuses a UI client call without affecting module import', async () => {
  const previous = process.env.LINE_MCP_CUA_DRIVER;
  try {
    delete process.env.LINE_MCP_CUA_DRIVER;
    await assert.rejects(
      withCuaClient(async () => { throw new Error('callback must not run'); }),
      error => error?.code === 'LINE_UI_BACKEND_UNAVAILABLE' && error.operationMayHaveCompleted === false,
    );
  } finally {
    if (previous === undefined) delete process.env.LINE_MCP_CUA_DRIVER;
    else process.env.LINE_MCP_CUA_DRIVER = previous;
  }
});

test('lazily validates each call against the live listTools inputSchema shape', () => {
  const counted = countedAjv();
  const validator = createCuaInputValidator(RUNTIME_TOOL_DESCRIPTORS, { ajv: counted.ajv });
  assert.deepEqual([...validator.tools].sort(), ['press_key', 'set_value']);
  assert.equal(counted.compileCount(), 0, 'schemas are not compiled while listing capabilities');

  validator.validate('set_value', {
    pid: 42,
    window_id: 99,
    element_token: 'snapshot-bound-token',
    value: 'draft text',
  });
  assert.equal(counted.compileCount(), 1);

  validator.validate('set_value', {
    pid: 42,
    element_token: 'another-token',
    value: 'another draft',
  });
  assert.equal(counted.compileCount(), 1, 'a tool schema is compiled once and reused');

  validator.validate('press_key', { pid: 42, key: 'return', delivery_mode: 'background' });
  assert.equal(counted.compileCount(), 2, 'a second CUA action compiles its own descriptor lazily');
});

test('rejects an unsupported set_value delivery_mode without exposing argument values', () => {
  const validator = createCuaInputValidator(RUNTIME_TOOL_DESCRIPTORS);
  const privateDraft = 'private draft must not be surfaced in validation errors';

  assert.throws(
    () => validator.validate('set_value', {
      pid: 42,
      element_token: 'private-element-token',
      value: privateDraft,
      delivery_mode: 'background',
    }),
    error => {
      assert.equal(error?.code, 'LINE_UI_INVALID_ARGUMENT');
      const publicError = JSON.stringify({ message: error?.message, details: error?.details });
      assert.equal(publicError.includes(privateDraft), false);
      assert.equal(publicError.includes('private-element-token'), false);
      assert.equal(publicError.includes('delivery_mode'), false);
      return true;
    },
  );
});

test('rejects a malformed listTools descriptor before any tool validation', () => {
  assert.throws(
    () => createCuaInputValidator([{ name: 'set_value' }]),
    { code: 'LINE_UI_BACKEND_PROTOCOL' },
  );
});

test('marks a timeout after dispatch as uncertain without retrying or exposing transport text', async () => {
  const privateValue = 'private draft must not appear after a timeout';
  let callCount = 0;
  const client = {
    async callTool() {
      callCount += 1;
      throw new Error(`transport timeout after dispatch: ${privateValue}`);
    },
  };

  await assert.rejects(
    callCuaTool(client, 'set_value', { value: privateValue }),
    error => {
      assert.equal(error?.code, 'LINE_UI_ACTION_UNCERTAIN');
      assert.equal(error?.operationMayHaveCompleted, true);
      const publicError = JSON.stringify({ message: error?.message, details: error?.details });
      assert.equal(publicError.includes(privateValue), false);
      assert.equal(publicError.includes('transport timeout'), false);
      return true;
    },
  );
  assert.equal(callCount, 1, 'transport rejection must not cause an automatic retry');
});

test('marks a rejected read as not completed', async () => {
  const client = {
    async callTool() { throw new Error('transport closed'); },
  };
  await assert.rejects(
    callCuaTool(client, 'get_window_state', { pid: 42, window_id: 99 }),
    error => error?.code === 'LINE_UI_ACTION_FAILED' && error?.operationMayHaveCompleted === false,
  );
});

test('session cleanup preserves the operation error and does not claim an input was untouched', async () => {
  const original = Object.assign(new Error('original operation'), {operationMayHaveCompleted:true});
  await closeCuaSession(async()=>{throw Error('cleanup failed');},{failure:original,inputAttempted:true});
  assert.equal(original.message,'original operation');
  assert.equal(original.operationMayHaveCompleted,true);
  assert.equal(original.details.sessionCleanupFailed,true);
  await assert.rejects(closeCuaSession(async()=>{throw Error('cleanup failed');},{inputAttempted:true}),e=>e.code==='LINE_UI_SESSION_CLOSE_FAILED'&&e.operationMayHaveCompleted===true);
});

test('snapshot requests elements only when supported by the live schema', async () => {
  const target = { pid: 42, window_id: 99 };
  const base = { pid: 42, window_id: 99, include_screenshot: true,
    max_elements: 60, max_depth: 25, query: 'fixture' };
  for (const treeFormat of [undefined, { type: 'string', enum: ['markdown', 'elements', 'both'] }]) {
    const name = 'get_window_state';
    const properties = Object.fromEntries(Object.keys(base).map(key => [key, {}]));
    if (treeFormat) properties.tree_format = treeFormat;
    const validator = createCuaInputValidator([{ name, inputSchema: {
      type: 'object', additionalProperties: false, properties,
    } }]);
    const api = { acceptsOption: validator.acceptsOption, async call(tool, args) {
      assert.equal(tool, name);
      validator.validate(tool, args);
      assert.deepEqual(args, treeFormat ? { ...base, tree_format: 'elements' } : base);
      return { elements: [] };
    } };
    assert.deepEqual(await snapshot(api, target, {
      screenshot: true, maxElements: 60, query: 'fixture',
    }), { elements: [] });
  }
});
