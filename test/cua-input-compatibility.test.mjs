import test from 'node:test';
import assert from 'node:assert/strict';
import {cuaInputInvocation} from '../src/extensions/cua-line-client.mjs';

test('CUA 0.28.2 right-click preserves exact target, snapshot and explicit delivery through its supported click interface',()=>{
  const args={pid:123,window_id:456,x:80,y:110,delivery_mode:'foreground',snapshot_id:'snapshot'};
  const fixed=cuaInputInvocation('right_click',args,{name:'cua-driver',version:'0.28.2'},new Set(['click','right_click']),'win32');
  assert.equal(fixed.name,'click');assert.deepEqual(fixed.args,{...args,button:'right'});assert.equal(args.button,undefined);
});

test('other CUA versions retain native semantics; the affected version refuses a missing safe interface',()=>{
  const args={pid:123,window_id:456,delivery_mode:'background'};
  assert.deepEqual(cuaInputInvocation('right_click',args,{name:'cua-driver',version:'0.28.3'},new Set(['right_click'])),{name:'right_click',args});
  assert.deepEqual(cuaInputInvocation('right_click',args,{name:'cua-driver',version:'0.28.2'},new Set(['right_click']),'darwin'),{name:'right_click',args});
  assert.deepEqual(cuaInputInvocation('click',args,{name:'cua-driver',version:'0.28.2'},new Set(['click'])),{name:'click',args});
  assert.throws(()=>cuaInputInvocation('right_click',args,{name:'cua-driver',version:'0.28.2'},new Set(['right_click']),'win32'),{code:'LINE_UI_CAPABILITY_UNAVAILABLE'});
});

test('CUA 0.46.1 right-click preserves the exact window and background route for tokens and pixels', () => {
  const version = { name: 'cua-driver', version: '0.46.1' };
  const tools = new Set(['click', 'right_click']);
  for (const reference of [{ element_token: 's0000002a:11' }, { x: 80, y: 110 }]) {
    const args = { pid: 123, window_id: 456, delivery_mode: 'background', ...reference };
    assert.deepEqual(cuaInputInvocation('right_click', args, version, tools, 'win32'),
      { name: 'click', args: { ...args, button: 'right' } });
    assert.equal(args.button, undefined);
    assert.throws(() => cuaInputInvocation('right_click', args, version, new Set(['right_click']), 'win32'),
      { code: 'LINE_UI_CAPABILITY_UNAVAILABLE' });
  }
});
