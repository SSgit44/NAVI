const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const exports = modules[name] = {};
  const js = ts.transpileModule(readFileSync(path.join(__dirname, `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('exports', 'require', js)(exports, relative => load(relative.replace('./', '')));
  return exports;
}
const { VehicleMission } = load('vehicle-mission');
const route = { id: 'r', path: [[121, 31], [121.0002, 31]], waypoints: [], createdAt: 1,
  distanceM: 20, geometryLengthM: 20, durationS: 100 };
function setup() {
  const sent = [];
  const mission = new VehicleMission((topic, value) => sent.push(JSON.parse(value.data)));
  mission.setConnected(true);
  const feedback = (session = 's', id = '', state = 'idle') => JSON.stringify({ version: 1,
    session_id: session, mission_id: id, state, reason: '', remaining_m: null, uncertainty_m: null, command_error: '' });
  mission.receive(feedback(), 10000);
  return { mission, sent, feedback };
}
test('任务开始携带独立编号、会话及完整路线；状态统计不能启动车辆', () => {
  const { mission, sent } = setup();
  const id = mission.start(route, 10000);
  assert.equal(sent[0].command, 'start'); assert.equal(sent[0].session_id, 's');
  assert.equal(sent[0].mission_id, id); assert.deepEqual(sent[0].route.path, route.path);
  assert.throws(() => mission.start(route, 10001));
  mission.heartbeat(10500); assert.equal(sent.at(-1).sequence, 1);
});
test('断线重连和开发板重启不回放开始任务，也不继续心跳', () => {
  const { mission, sent, feedback } = setup();
  mission.start(route, 10000);
  mission.setConnected(false); mission.setConnected(true); mission.receive(feedback(), 10100);
  mission.heartbeat(10500); assert.equal(sent.length, 1); assert.equal(mission.active, false);
  mission.start(route, 11000); mission.receive(feedback('new-session'), 11001);
  mission.heartbeat(11500); assert.equal(sent.length, 2); assert.equal(mission.active, false);
});
test('反馈失联、拒绝、完成和取消后停止心跳，未知会话不能开始', () => {
  const { mission, sent, feedback } = setup();
  const id = mission.start(route, 10000);
  mission.receive(feedback('s', id, 'arrived'), 10100);
  assert.equal(mission.active, false);
  mission.start(route, 10500); mission.heartbeat(12000);
  assert.equal(sent.at(-1).command, 'cancel'); assert.equal(mission.active, false);
  mission.setConnected(false); mission.setConnected(true);
  assert.throws(() => mission.start(route, 12001));
});
test('错误反馈不能刷新会话和反馈有效期', () => {
  const { mission } = setup();
  mission.receive('{bad', 11000);
  mission.receive(JSON.stringify({ version: 1, session_id: 'x' }), 11500);
  assert.throws(() => mission.start(route, 12000));
});
