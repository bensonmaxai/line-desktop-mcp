import test from 'node:test';
import assert from 'node:assert/strict';
import { keepSidebar, keepDetach } from '../src/extensions/line-keep-open.mjs';
import { LineUi } from '../src/extensions/line-ui.mjs';
import { readKeepOpenIdentity } from '../src/extensions/line-local-reader.mjs';

const window = { bounds: { x: 10, y: 20, width: 1100, height: 1321 } };
const button = (index, label, x, y, w, h, parent_index) => ({
  element_index: index, role: 'Button', label, frame: { x, y, w, h },
  enabled: true, actions: ['invoke'], parent_index,
});
const sidebar = button(1, 'Keep筆記', 25, 1200, 32, 32, 20);
const header = { element_index: 4, role: 'Group', frame: { x: 375, y: 75, w: 735, h: 52 } };
const title = button(5, 'Keep筆記', 406, 91, 60, 19, 4);
const detach = button(6, '以個別視窗開啟', 466, 89, 20, 24, 4);

test('exact unique sidebar and adjacent named header controls are required', () => {
  const state = { elements_complete: true, elements: [sidebar, header, title, detach] };
  assert.equal(keepSidebar(state, window), sidebar);
  assert.equal(keepDetach(state, window, header), detach);
  assert.equal(keepSidebar({ ...state, elements: [...state.elements, { ...sidebar, element_index: 8 }] }, window), null);
  assert.equal(keepSidebar({ ...state, elements_complete: false }, window), null);
  assert.equal(keepDetach({ ...state, elements: [...state.elements, { ...detach, element_index: 9 }] }, window, header), null);
  assert.equal(keepDetach({ ...state, elements: [sidebar, header, title, { ...detach, enabled: false }] }, window, header), null);
  assert.equal(keepDetach({ ...state, elements: [sidebar, header, title, { ...detach, frame: { ...detach.frame, x: 467 } }] }, window, header), null);
});

test('Keep open rejects bound, wrong-type and unresolved requests before GUI access', async () => {
  let accessed = 0;
  const ui = new LineUi({
    automation: {},
    withClient: async () => { accessed++; throw new Error('unexpected GUI'); },
    readKeepIdentity: async () => { throw Object.assign(new Error('ambiguous'), { code: 'CHAT_AMBIGUOUS' }); },
    runOperation: async (_kind, callback) => callback(),
  });
  await assert.rejects(ui.openChat({ chatName: 'Keep筆記', chatType: 'group' }), { code: 'LINE_INVALID_ARGUMENT' });
  await assert.rejects(ui.openChat({ chatName: 'Keep筆記', chatType: 'direct', expectedChatRef: 'chat:' + 'a'.repeat(24), expectedOwnSenderRef: 'sender:' + 'b'.repeat(24) }), { code: 'LINE_INVALID_ARGUMENT' });
  await assert.rejects(ui.openChat({ chatName: 'Keep筆記' }), { code: 'CHAT_AMBIGUOUS' });
  ui.readKeepIdentity = async () => false;
  await assert.rejects(ui.openChat({ chatName: 'Keep筆記' }), { code: 'LINE_CHAT_IDENTITY_UNVERIFIED' });
  assert.equal(accessed, 0);
});

test('identity proof uses only the dedicated mode and rejects invalid results', async () => {
  let requested;
  const valid = await readKeepOpenIdentity({ runProcess: async scope => {
    requested = scope;
    return { code: 0, stdout: JSON.stringify({ ok: true, mode: 'keepOpenIdentity',
      freshness: { clockOrderValid: true, capturedAfterInitialization: true } }) };
  } });
  assert.equal(valid, true);
  assert.deepEqual(requested, { mode: 'keepOpenIdentity' });
  await assert.rejects(readKeepOpenIdentity({ runProcess: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, code: 'CHAT_NOT_FOUND' }) }) }), { code: 'CHAT_NOT_FOUND' });
  await assert.rejects(readKeepOpenIdentity({ runProcess: async () => ({ code: 0, stdout: JSON.stringify({ ok: true }) }) }), { code: 'LOCAL_READER_INVALID_RESULT' });
  await assert.rejects(readKeepOpenIdentity({ runProcess: async () => ({ code: 1, stdout: JSON.stringify({ ok: true, mode: 'keepOpenIdentity' }) }) }), { code: 'LOCAL_READER_FAILED' });
});
