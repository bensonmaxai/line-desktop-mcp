import { LineToolError } from './line-runtime.mjs';
import { mainLineWindow, snapshot, elementTarget } from './cua-line-client.mjs';
import { inspectDetachedChat, findMainChatBands, findContentHeaderContainer } from './line-ui.mjs';

const name = 'Keep筆記';
const frame = element => element?.frame;
const inside = (box, outer) => box && outer
  && [box.x, box.y, box.w, box.h, outer.x, outer.y, outer.width, outer.height].every(Number.isFinite)
  && box.w > 0 && box.h > 0 && box.x >= outer.x && box.y >= outer.y
  && box.x + box.w <= outer.x + outer.width && box.y + box.h <= outer.y + outer.height;
const invokable = element => element.enabled === true && element.actions?.includes('invoke');
const unavailable = () => { throw new LineToolError('LINE_CHAT_UNVERIFIED',
  'The Keep memo shortcut or title could not be uniquely verified.', { sendDispatched: false }); };

export function keepSidebar(state, window) {
  if (state?.elements_complete !== true || !Array.isArray(state.elements)) return null;
  const matches = state.elements.filter(element => element.role === 'Button' && element.label === name
    && inside(frame(element), window.bounds) && frame(element).x + frame(element).w <= window.bounds.x + 64);
  return matches.length === 1 && invokable(matches[0]) ? matches[0] : null;
}

export function keepDetach(state, window, header) {
  if (state?.elements_complete !== true || !Array.isArray(state.elements)
      || header?.role !== 'Group' || frame(header)?.h !== 52 || !inside(frame(header), window.bounds)) return null;
  const children = state.elements.filter(item => item.parent_index === header.element_index);
  const titles = children.filter(item => item.role === 'Button' && item.label === name);
  const buttons = children.filter(item => item.role === 'Button' && item.label === '以個別視窗開啟');
  if (titles.length !== 1 || buttons.length !== 1) return null;
  const title = frame(titles[0]), detach = frame(buttons[0]);
  const box = frame(header);
  if (!invokable(buttons[0]) || !title || !detach || detach.w !== 20 || detach.h !== 24
      || detach.y !== box.y + 14 || title.x + title.w !== detach.x
      || title.x < box.x || title.y < box.y || title.x + title.w > box.x + box.w
      || title.y + title.h > box.y + box.h || detach.x < box.x || detach.y < box.y
      || detach.x + detach.w > box.x + box.w || detach.y + detach.h > box.y + box.h) return null;
  return buttons[0];
}

export async function openKeepChat(ui, api, check) {
  let inspected = await inspectDetachedChat(api, name);
  if (inspected) return inspected;
  let window = await mainLineWindow(api);
  const target = { pid: window.pid, window_id: window.window_id };
  if ((await ui.automation.activateLine({ ...target, title: window.title }))?.success !== true) {
    throw new LineToolError('LINE_FOCUS_UNAVAILABLE', 'LINE could not be activated.');
  }
  const activated = await mainLineWindow(api);
  if (activated.pid !== target.pid || activated.window_id !== target.window_id
      || activated.minimized || !activated.is_on_screen
      || (!window.minimized && ['x', 'y', 'width', 'height'].some(key => activated.bounds?.[key] !== window.bounds?.[key]))) {
    throw new LineToolError('LINE_TARGET_CHANGED', 'The verified LINE main window changed after activation.');
  }
  window = activated;
  check();
  let state = await snapshot(api, target);
  const sidebar = keepSidebar(state, window);
  if (!sidebar) unavailable();
  await api.call('click', { ...elementTarget(target, state, sidebar), delivery_mode: 'background' });
  state = await snapshot(api, target);
  const bands = findMainChatBands(state);
  const header = bands.length === 1 && findContentHeaderContainer(state, bands[0]);
  const detach = keepDetach(state, window, header);
  if (!detach) unavailable();
  check();
  await api.call('click', { ...elementTarget(target, state, detach), delivery_mode: 'background' });
  await snapshot(api, target);
  for (let attempt = 0; attempt < 5; attempt++) {
    check();
    inspected = await inspectDetachedChat(api, name);
    if (inspected) return inspected;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  unavailable();
}
