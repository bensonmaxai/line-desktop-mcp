import fs from 'node:fs';
import { configuredCuaDriverPath, LineToolError, runtimeImport, runtimeRequire } from './line-runtime.mjs';
import { countLineUiMetric, startLineUiPhase } from './line-ui-metrics.mjs';

const CUA_INPUT_TOOLS = new Set([
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'move_cursor',
  'type_text', 'press_key', 'hotkey', 'set_value', 'clipboard_write', 'clipboard_clear',
  'mouse_down', 'mouse_up', 'key_down', 'key_up',
  'set_window_frame', 'invoke_menu', 'launch_app', 'start_session', 'end_session', 'desktop_action',
]);

/** Existing CUA runtime, used over its public stdio MCP protocol. No daemon,
 * installer, permission-mode override, recording, or private pipe protocol. */
export async function withCuaClient(callback, { deadline } = {}) {
  const remaining = maximum => {
    const value = deadline === undefined ? maximum : Math.min(maximum, deadline - Date.now());
    if(value <= 0) throw new LineToolError('LINE_SEND_TIMEOUT', 'LINE operation reached its deadline.');
    return value;
  };
  const driverPath = requireConfiguredCuaDriver();
  const [{ Client }, { StdioClientTransport }, { AjvJsonSchemaValidator }] = await Promise.all([
    runtimeImport('@modelcontextprotocol/sdk/client/index.js'),
    runtimeImport('@modelcontextprotocol/sdk/client/stdio.js'),
    runtimeImport('@modelcontextprotocol/sdk/validation/ajv'),
  ]);
  const ajv = createCuaAjv();
  const client = new Client({ name: 'line-desktop-ui-adapter', version: '1.0.0' }, { jsonSchemaValidator: new AjvJsonSchemaValidator(ajv) });
  const transport = new StdioClientTransport({ command: driverPath, args: process.platform === 'win32' ? ['mcp', '--direct'] : ['mcp'], stderr: 'pipe' });
  // Drain diagnostic output without writing possible UI content into a log.
  transport.stderr?.on('data', () => {});
  let connected = false;
  let failure;
  let inputAttempted = false;
  try {
    const connectOptions = { timeout: remaining(20000) };
    const stopConnect = startLineUiPhase('cuaConnect');
    countLineUiMetric('processStartAttempts');
    try { await client.connect(transport, connectOptions); }
    finally { stopConnect(); }
    connected = true;
    const stopTools = startLineUiPhase('cuaTools');
    let listed;
    try { listed = await client.listTools({}, {timeout:remaining(20000)}); }
    finally { stopTools(); }
    const inputValidator = createCuaInputValidator(listed?.tools, { ajv });
    const tools = inputValidator.tools;
    const api = {
      tools,
      acceptsOption: inputValidator.acceptsOption,
      serverVersion: client.getServerVersion(),
      async call(name, args) {
        if (!tools.has(name)) throw new LineToolError('LINE_UI_CAPABILITY_UNAVAILABLE', `The active CUA runtime does not advertise ${name}.`);
        inputValidator.validate(name, args);
        if (CUA_INPUT_TOOLS.has(name)) inputAttempted = true;
        const invocation = cuaInputInvocation(name,args,client.getServerVersion(),tools);
        inputValidator.validate(invocation.name,invocation.args);
        const result = await callCuaTool(client, invocation.name, invocation.args, {timeout:remaining(25000)});
        const data = unwrapCua(result);
        if (result.isError) {
          throw new LineToolError('LINE_UI_ACTION_REFUSED', `CUA ${name}: ${data.message || data.error || data.code || 'operation refused'}`, {
            backendCode: data.code ?? null,
            escalation: data.escalation ?? null,
            // Never replay an input merely because its acknowledgment failed.
            operationMayHaveCompleted: !['list_windows', 'get_window_state', 'get_config'].includes(name),
          });
        }
        return { ...data, images: (result.content || []).filter(item => item.type === 'image') };
      },
    };
    return await callback(api);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Closing the public transport ends this operation's CUA control session.
    const stopClose = startLineUiPhase('cuaClose');
    try { await closeCuaSession(() => connected ? client.close() : transport.close(), { failure, inputAttempted }); }
    finally { stopClose(); }
  }
}

/**
 * Validate the optional driver only at the UI-operation boundary. The
 * injectable filesystem is for deterministic tests; withCuaClient always
 * obtains its path from LINE_MCP_CUA_DRIVER.
 */
export function requireConfiguredCuaDriver({
  configuredPath = configuredCuaDriverPath(),
  fileSystem = fs,
} = {}) {
  const driverPath = configuredCuaDriverPath(configuredPath);
  if (!driverPath) {
    throw new LineToolError(
      'LINE_UI_BACKEND_UNAVAILABLE',
      'LINE_MCP_CUA_DRIVER must name an absolute CUA Driver executable before a LINE UI operation can run.',
    );
  }
  try {
    if (!fileSystem.statSync(driverPath).isFile()) throw new Error('not a regular file');
  } catch {
    throw new LineToolError(
      'LINE_UI_BACKEND_UNAVAILABLE',
      'LINE_MCP_CUA_DRIVER must name an existing regular CUA Driver executable before a LINE UI operation can run.',
    );
  }
  return driverPath;
}

export async function closeCuaSession(close, { failure, inputAttempted = false } = {}) {
  try { await close(); }
  catch {
    if (failure) {
      // Preserve the original operation error, including its uncertainty flag.
      try { failure.details = { ...failure.details, sessionCleanupFailed: true }; } catch {}
      return;
    }
    throw new LineToolError('LINE_UI_SESSION_CLOSE_FAILED', 'The LINE UI operation ended, but its control session could not be confirmed closed. Inspect the result before retrying.', { operationMayHaveCompleted: inputAttempted, sessionCleanupFailed: true });
  }
}

/**
 * A rejected MCP request has no trustworthy completion signal. Treat input
 * operations as possibly completed, while reads can safely report failure.
 * The fixed errors intentionally omit transport/backend text and arguments.
 */
export async function callCuaTool(client, name, args, {timeout=25000} = {}) {
  const stopCall = startLineUiPhase('cuaCall');
  try {
    return await client.callTool({ name, arguments: args }, undefined, { timeout });
  } catch {
    if (isCuaInputTool(name)) {
      throw new LineToolError(
        'LINE_UI_ACTION_UNCERTAIN',
        `CUA ${name} lost its completion response. Inspect fresh UI state before deciding whether to retry.`,
        { operationMayHaveCompleted: true },
      );
    }
    throw new LineToolError(
      'LINE_UI_ACTION_FAILED',
      `CUA ${name} could not complete.`,
      { operationMayHaveCompleted: false },
    );
  } finally { stopCall(); }
}

function isCuaInputTool(name) {
  return CUA_INPUT_TOOLS.has(name);
}

/**
 * Build input validators from the runtime's current listTools descriptors.
 * Schemas are compiled only when their named tool is first called, keeping
 * connection setup read-only and avoiding a hard-coded CUA action schema.
 */
export function createCuaInputValidator(toolDescriptors, { ajv = createCuaAjv() } = {}) {
  if (!Array.isArray(toolDescriptors)) {
    throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'CUA did not return a tools array with input schemas.');
  }
  if (!ajv || typeof ajv.compile !== 'function') {
    throw new TypeError('ajv must provide compile(schema).');
  }

  const descriptors = new Map();
  for (const descriptor of toolDescriptors) {
    if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name || descriptor.inputSchema === undefined) {
      throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'CUA advertised an invalid tool descriptor.');
    }
    if (descriptors.has(descriptor.name)) {
      throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', `CUA advertised duplicate tool name ${descriptor.name}.`);
    }
    descriptors.set(descriptor.name, descriptor);
  }

  const validators = new Map();
  return {
    tools: new Set(descriptors.keys()),
    acceptsOption(name, key, value) {
      const values = descriptors.get(name)?.inputSchema?.properties?.[key]?.enum;
      return Array.isArray(values) && values.includes(value);
    },
    validate(name, args) {
      const descriptor = descriptors.get(name);
      if (!descriptor) {
        throw new LineToolError('LINE_UI_CAPABILITY_UNAVAILABLE', `The active CUA runtime does not advertise ${name}.`);
      }
      let validate = validators.get(name);
      if (!validate) {
        try {
          validate = ajv.compile(descriptor.inputSchema);
        } catch {
          throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', `CUA ${name} advertised an input schema that could not be validated.`);
        }
        validators.set(name, validate);
      }
      if (validate(args)) return;
      throw new LineToolError(
        'LINE_UI_INVALID_ARGUMENT',
        `CUA ${name} arguments do not match the active runtime schema.`,
        { schemaIssueCount: Array.isArray(validate.errors) ? validate.errors.length : 0 },
      );
    },
  };
}

function createCuaAjv() {
  const Ajv = runtimeRequire()('ajv');
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
  runtimeRequire()('ajv-formats')(ajv);
  ajv.addFormat('uint32', { type: 'number', validate: n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff });
  ajv.addFormat('uint64', { type: 'number', validate: n => Number.isSafeInteger(n) && n >= 0 });
  return ajv;
}

export function unwrapCua(result) {
  const text = (result?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object' && !result.isError) return structured;
  try { return { ...structured, ...JSON.parse(text) }; } catch { return { ...structured, message: text }; }
}

export async function lineWindows(api) {
  const response = await api.call('list_windows', {});
  const windows = response.windows;
  if (!Array.isArray(windows)) throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'CUA did not return a windows array.');
  return windows.filter(window => /^(LINE|LINE\.exe)$/i.test(window.app_name || ''));
}

export async function mainLineWindow(api) {
  const windows = await lineWindows(api);
  const matches = windows.filter(window => window.title === 'LINE'
    && (window.is_on_screen || window.minimized));
  const proven = [];
  let inconclusive = 0;
  for (const window of matches) {
    // Existing guarded navigation refuses visible windows below 700 x 600.
    // Size only excludes unsupported UI; it never selects the main window.
    if (!window.minimized && (window.bounds?.width < 700 || window.bounds?.height < 600)) continue;
    let state;
    try { state = await snapshot(api, window); }
    catch { inconclusive++; continue; }
    if (hasMainLineShell(window, state)) proven.push(window);
    else if (state.elements_complete !== true
      || (state.total_element_count !== undefined
        && state.total_element_count !== state.elements.length)) inconclusive++;
  }
  if (proven.length !== 1 || inconclusive !== 0) throw new LineToolError('LINE_TARGET_NOT_UNIQUE', `Expected one structurally verified LINE main window, found ${proven.length}; ${inconclusive} candidate(s) could not be ruled out.`, { candidateCount: proven.length, inconclusiveCount: inconclusive, titleCandidateCount: matches.length });
  return proven[0];
}

/** A title-LINE popup can have a search Edit and List too. Require the full
 * main shell: navigation rail, split content panes, divider, and sidebar
 * search/list in one fresh accessibility tree. Size or z-order alone proves
 * nothing. A positive full-shell proof can survive unrelated UIA gaps. */
export function hasMainLineShell(window, state) {
  const elements = state?.elements;
  const bounds = window?.bounds;
  if (!Array.isArray(elements) || !bounds) return false;
  const rect = element => {
    const frame = element?.frame;
    const value = { x:Number(frame?.x), y:Number(frame?.y),
      width:Number(frame?.w ?? frame?.width), height:Number(frame?.h ?? frame?.height) };
    return Object.values(value).every(Number.isFinite) && value.width > 0 && value.height > 0 ? value : null;
  };
  const near = (a, b, tolerance = 3) => Math.abs(a - b) <= tolerance;
  const right = box => box.x + box.width;
  const bottom = box => box.y + box.height;
  const inside = (inner, outer) => inner && outer && inner.x >= outer.x - 2
    && inner.y >= outer.y - 2 && right(inner) <= right(outer) + 2
    && bottom(inner) <= bottom(outer) + 2;
  const byIndex = new Map(elements.map(element => [element.element_index, element]));
  const descendantOf = (element, ancestor) => {
    let parent = element.parent_index;
    for (let depth = 0; depth < 20 && Number.isInteger(parent); depth++) {
      if (parent === ancestor.element_index) return true;
      parent = byIndex.get(parent)?.parent_index;
    }
    return false;
  };
  const children = (parent, role) => elements.filter(element =>
    element.parent_index === parent.element_index && element.role === role);
  const roots = elements.filter(element => element.role === 'Window'
    && !Number.isInteger(element.parent_index));
  if (roots.length !== 1) return false;
  const root = roots[0], outer = rect(root);
  if (!outer || (window.minimized
      ? outer.width < 700 || outer.height < 600
      : !near(outer.x, bounds.x) || !near(outer.y, bounds.y)
        || !near(outer.width, bounds.width) || !near(outer.height, bounds.height))) return false;
  const shells = children(root, 'Custom').filter(element => {
    const box = rect(element);
    return inside(box, outer) && box.width >= outer.width * .65
      && box.height >= outer.height * .7 && box.x > outer.x + 30
      && box.x < outer.x + 150 && near(bottom(box), bottom(outer));
  });
  if (shells.length !== 1) return false;
  const shell = shells[0], content = rect(shell);
  const rails = children(root, 'Group').filter(element => {
    const box = rect(element);
    return box && inside(box, outer) && near(box.x, outer.x)
      && near(right(box), content.x) && box.height >= content.height * .8;
  });
  if (rails.length !== 1) return false;
  const panes = children(shell, 'Group').map(element => ({ element, box:rect(element) }))
    .filter(item => item.box && inside(item.box, content)
      && near(item.box.y, content.y) && item.box.height >= content.height * .8);
  const sidebars = panes.filter(item => near(item.box.x, content.x)
    && item.box.width >= 150 && item.box.width <= content.width * .45);
  if (sidebars.length !== 1) return false;
  const sidebar = sidebars[0];
  const bodies = panes.filter(item => near(item.box.x, right(sidebar.box), 5)
    && item.box.width >= content.width * .4 && near(right(item.box), right(content)));
  if (bodies.length !== 1) return false;
  const dividers = children(shell, 'Thumb').filter(element => {
    const box = rect(element);
    return box && String(element.label || '').startsWith('qt_splithandle_')
      && box.width <= 10 && box.height >= content.height * .8
      && near(box.x, right(sidebar.box), 5);
  });
  if (dividers.length !== 1) return false;
  const edits = elements.filter(element => element.role === 'Edit'
    && descendantOf(element, sidebar.element) && inside(rect(element), sidebar.box)
    && rect(element).width > 100 && rect(element).height < 70
    && rect(element).y < sidebar.box.y + 100);
  const lists = elements.filter(element => element.role === 'List'
    && descendantOf(element, sidebar.element) && inside(rect(element), sidebar.box)
    && rect(element).width >= sidebar.box.width * .8
    && rect(element).height >= sidebar.box.height * .5);
  return edits.length === 1 && lists.length === 1
    && rect(lists[0]).y >= bottom(rect(edits[0])) - 8;
}

export async function snapshot(api, target, { screenshot = false, query, maxElements = 800 } = {}) {
  const stopSnapshot = startLineUiPhase('snapshot');
  if (screenshot) countLineUiMetric('screenshotRequests');
  try {
    const result = await api.call('get_window_state', {
      pid: target.pid, window_id: target.window_id,
      include_screenshot: screenshot, max_elements: maxElements, max_depth: 25,
      ...(api.acceptsOption?.('get_window_state', 'tree_format', 'elements') ? { tree_format: 'elements' } : {}),
      ...(query ? { query } : {}),
    });
    if (!Array.isArray(result.elements)) throw new LineToolError('LINE_UI_TREE_UNAVAILABLE', 'LINE did not expose a structured accessibility tree. Continue using visual Computer Use.');
    return result;
  } finally { stopSnapshot(); }
}

export function elementTarget(target, state, element) {
  if (element.enabled === false) throw new LineToolError('LINE_CONTROL_DISABLED', 'The requested LINE control is disabled.');
  const ref = element.element_token
    ? { element_token: element.element_token }
    : { element_index: element.element_index, snapshot_id: state.snapshot_id };
  if (!element.element_token && (!Number.isInteger(element.element_index) || !state.snapshot_id)) {
    throw new LineToolError('LINE_UI_REFERENCE_INVALID', 'CUA did not return a snapshot-bound reference.');
  }
  return { pid: target.pid, window_id: target.window_id, ...ref };
}

export function uniqueElement(state, predicate, label) {
  const matches = state.elements.filter(predicate);
  if (matches.length !== 1) throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', `${label}: expected one accessible control, found ${matches.length}. Use a fresh visual observation instead of guessing.`, { candidateCount: matches.length });
  return matches[0];
}

export function exactLabel(labels, roles) {
  return item => labels.includes(item.label) && (!roles || roles.some(role => String(item.role).toLowerCase().includes(role.toLowerCase())));
}

/** These Windows right_click aliases do not preserve background delivery
 * reliably. Their click(button:right) interface accepts the same exact target. */
export function cuaInputInvocation(name, args, version, tools, platform = process.platform) {
  if (platform !== 'win32' || name !== 'right_click' || version?.name !== 'cua-driver'
      || !['0.28.2', '0.46.1'].includes(version.version)) return { name, args };
  if (!tools.has('click')) {
    throw new LineToolError('LINE_UI_CAPABILITY_UNAVAILABLE', 'This CUA build requires its exact-window click interface for right-click.');
  }
  return { name: 'click', args: { ...args, button: 'right' } };
}
