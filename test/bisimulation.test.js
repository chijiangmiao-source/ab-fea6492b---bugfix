'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { audit, weakTargets, normalize, TAU, responseRoute } = require('../src/bisimulation');
const { samples } = require('../src/samples');

// 以录入规程核对路径：每一步都必须对应一条已录入迁移，且逐步首尾相接
function transitionIndex(spec) {
  const map = new Map();
  for (const t of spec.transitions) map.set(t.id, t);
  return map;
}
function assertRouteIsRegistered(steps, spec) {
  const byId = transitionIndex(spec);
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const t = byId.get(s.transitionId);
    assert.ok(t, `步骤迁移标识必须已录入：${s.transitionId}`);
    assert.equal(t.from, s.from, `迁移 ${s.transitionId} 起点须一致`);
    assert.equal(t.action, s.action, `迁移 ${s.transitionId} 动作须一致`);
    assert.equal(t.to, s.to, `迁移 ${s.transitionId} 终点须一致`);
    if (i > 0) assert.equal(steps[i - 1].to, s.from, '候选响应必须逐步连续');
  }
}

test('仅以 tau 环重命名而等价：关系包含两个初始状态对', () => {
  const r = audit(samples.equivalent.procA, samples.equivalent.procB);
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, true);
  assert.deepEqual(r.initialPairs, [['S0', 'P0'], ['P0', 'S0']]);
  assert.ok(r.initialAlive.every(Boolean));
  assert.ok(r.finalRelation.some((p) => p[0] === 'S0' && p[1] === 'P0'));
  assert.ok(r.finalRelation.some((p) => p[0] === 'P0' && p[1] === 'S0'));
  // 行为不同的配对（如 S0 与终态 P1）被淘汰属正常；初始对存活即等价
  assert.ok(!r.eliminatedPairs.some((p) => p.pair[0] === 'S0' && p.pair[1] === 'P0'));
});

test('缺失匹配动作：不等价，首个失败义务是缺失侧无法承接的动作', () => {
  const r = audit(samples.missing.procA, samples.missing.procB);
  assert.equal(r.equivalent, false);
  const f = r.firstEliminated;
  assert.equal(f.action, 'x'); // 有 x 的 A 方挑战，B 方无法承接
  assert.equal(f.challenger, 'A');
  assert.ok(f.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));
  // 四个跨侧对中三个无法匹配（死态对 (a1,b1) 存活）
  assert.equal(r.rounds[0].eliminated.length, 3);
  const initPair = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(initPair.round, 1);
});

test('静默前缀且后继动作不匹配：初始对第 2 轮淘汰，候选响应须逐步回放真实迁移', () => {
  const { procA, procB } = samples.silentPrefix;
  const r = audit(procA, procB);
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, false);

  // 第 1 轮：x 后继 (a1,b2) 因可观察动作 p vs q 不匹配而淘汰
  const p12 = r.eliminatedPairs.find((p) => p.pair[0] === 'a1' && p.pair[1] === 'b2');
  assert.ok(p12, `应存在淘汰对 (a1,b2)：${JSON.stringify(r.eliminatedPairs.map((p) => p.pair))}`);
  assert.equal(p12.round, 1);
  assert.equal(p12.action, 'p');
  assert.equal(p12.challenger, 'A');

  // 初始对 (a0,b0) 在后续轮次（第 2 轮）才正确淘汰
  const p00 = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.ok(p00);
  assert.equal(p00.round, 2);
  assert.equal(p00.action, 'x');
  assert.equal(p00.challenger, 'A');

  // 候选响应必须展示实际连续路径：b0 --tau(bt)--> b1 --x(bx)--> b2，
  // 而不是规程中不存在的 b0 --x--> b2 直达动作
  const fail = p00.transitions.find((t) => t.source === 'a1');
  assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
  assert.equal(fail.responses.length, 1);
  const w = fail.responses[0];
  assert.equal(w.target, 'b2');
  assert.deepEqual(w.pair, ['a1', 'b2']);
  assert.equal(w.eliminatedRound, 1);
  assert.equal(w.route.kind, 'WEAK');
  assert.equal(w.route.start, 'b0');
  assert.equal(w.route.end, 'b2');
  assert.deepEqual(
    w.route.steps.map((s) => [s.from, s.action, s.to, s.transitionId]),
    [['b0', 'tau', 'b1', 'bt'], ['b1', 'x', 'b2', 'bx']],
  );
  assertRouteIsRegistered(w.route.steps, procB);

  // 全部失败义务的全部候选响应都须可逐步复算（含多静默前缀、分叉候选）
  for (const ep of r.eliminatedPairs) {
    const responderSpec = ep.challenger === 'A' ? procB : procA;
    for (const t of ep.transitions) {
      if (t.reason !== 'ALL_RESPONSES_ELIMINATED') continue;
      for (const cand of t.responses) {
        assert.equal(cand.route.start, ep.challenger === 'A' ? ep.pair[1] : ep.pair[0]);
        assert.equal(cand.route.end, cand.target);
        assertRouteIsRegistered(cand.route.steps, responderSpec);
      }
    }
  }
});

test('responseRoute：直达迁移为 DIRECT 单步，弱承接为 tau 前缀 + 同动作迁移', () => {
  const spec = {
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 't1', from: 's', action: 'tau', to: 'u' },
      { id: 'a1', from: 'u', action: 'a', to: 'p' },
    ],
  };
  const proc = normalize(spec);
  const weak = responseRoute(proc, 's', 'a', 'p');
  assert.equal(weak.kind, 'WEAK');
  assert.deepEqual(weak.steps.map((s) => s.transitionId), ['t1', 'a1']);
  assertRouteIsRegistered(weak.steps, spec);

  const direct = responseRoute(proc, 'u', 'a', 'p');
  assert.equal(direct.kind, 'DIRECT');
  assert.deepEqual(direct.steps, [{ from: 'u', action: 'a', to: 'p', transitionId: 'a1' }]);

  const tauRoute = responseRoute(proc, 's', TAU, 'u');
  assert.deepEqual(tauRoute.steps, [{ from: 's', action: 'tau', to: 'u', transitionId: 't1' }]);
  const stutter = responseRoute(proc, 's', TAU, 's');
  assert.equal(stutter.kind, 'STUTTER');
  assert.deepEqual(stutter.steps, []);
});

test('responseRoute：含静默环与多个静默前缀时路径确定且全部对应已录入迁移', () => {
  const spec = {
    states: [{ name: 's' }, { name: 'u' }, { name: 'v' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 'loop', from: 's', action: 'tau', to: 's' }, // 静默环
      { id: 'su', from: 's', action: 'tau', to: 'u' },
      { id: 'uv', from: 'u', action: 'tau', to: 'v' },
      { id: 'vs', from: 'v', action: 'tau', to: 's' },
      { id: 'ap1', from: 'v', action: 'a', to: 'p' },
      { id: 'ap2', from: 'v', action: 'a', to: 'p' }, // 同端点分叉：取最小标识 ap1
    ],
  };
  const proc = normalize(spec);
  const route = responseRoute(proc, 's', 'a', 'p');
  assert.equal(route.kind, 'WEAK');
  // BFS 字典序展开：s -> u -> v，静默环不参与生成树
  assert.deepEqual(route.steps.map((s) => [s.from, s.action, s.to, s.transitionId]), [
    ['s', 'tau', 'u', 'su'],
    ['u', 'tau', 'v', 'uv'],
    ['v', 'a', 'p', 'ap1'],
  ]);
  assertRouteIsRegistered(route.steps, spec);
  // 确定性：重复复算结果一致
  assert.deepEqual(responseRoute(proc, 's', 'a', 'p'), route);
});

test('多轮级联：初始对第 2 轮淘汰，失败义务只引用第 1 轮淘汰对', () => {
  const r = audit(samples.cascade.procA, samples.cascade.procB);
  assert.equal(r.equivalent, false);

  const p11 = r.eliminatedPairs.find((p) => p.pair[0] === 'a1' && p.pair[1] === 'b1');
  assert.equal(p11.round, 1);
  assert.equal(p11.action, 'y');

  const p00 = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(p00.round, 2);
  assert.equal(p00.action, 'x');
  assert.equal(p00.challenger, 'A');

  const fail = p00.transitions.find((t) => t.source === 'a1');
  assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
  assert.equal(fail.responses.length, 1);
  assert.deepEqual(fail.responses[0].pair, ['a1', 'b1']);
  assert.equal(fail.responses[0].eliminatedRound, 1);

  // 每条失败义务的依据都来自严格更早的轮次（自底向上可复算）
  for (const ep of r.eliminatedPairs) {
    for (const t of ep.transitions) {
      if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
        for (const w of t.responses) {
          assert.ok(typeof w.eliminatedRound === 'number');
          assert.ok(w.eliminatedRound < ep.round, `依据轮次应更早: ${JSON.stringify(w)} in round ${ep.round}`);
        }
        // 依据按轮次递减排序
        const rounds = t.responses.map((w) => w.eliminatedRound);
        assert.deepEqual(rounds, [...rounds].sort((x, y) => y - x));
      }
    }
  }
});

test('tau 链上的弱转移：静默前缀后承接动作', () => {
  const proc = normalize({
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }, { name: 'v' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'p' },
      { id: '3', from: 'p', action: 'a', to: 'v' },
    ],
  });
  assert.deepEqual([...weakTargets(proc, 's', 'a')], ['v']);
  assert.deepEqual([...weakTargets(proc, 's', TAU)].sort(), ['p', 's', 'u']);
});

test('静默前缀 + 可观察承接的典型等价：tau 前缀进程与直接动作进程', () => {
  const A = {
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'u' }, // tau 自环
      { id: '3', from: 'u', action: 'a', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: '1', from: 'q', action: 'a', to: 'r' }],
  };
  const r = audit(A, B);
  assert.equal(r.equivalent, true);
});

test('输入无效：一次显示所有问题并清除旧结论', () => {
  const bad = {
    states: [{ name: 'x' }, { name: 'x' }, {}, { name: 'bad name' }],
    initial: 'ghost',
    transitions: [
      { id: 't', from: 'x', action: '', to: 'nope' },
      { id: 't', from: 'x', action: 'foo', to: 'x' },
      { id: 'a1', from: 'x', action: 'a', to: 'x' },
      { id: 'a2', from: 'x', action: 'b', to: 'x' },
      { id: 'a3', from: 'x', action: 'c', to: 'x' },
      { id: 'a4', from: 'x', action: 'd', to: 'x' },
      { id: 'a5', from: 'x', action: 'e', to: 'x' },
    ],
  };
  const r = audit(bad, { states: [], initial: '', transitions: [] });
  assert.equal(r.ok, false);
  assert.equal(r.equivalent, null);
  const codes = r.errors.map((e) => e.code);
  for (const code of [
    'STATE_DUPLICATE',
    'STATE_NAME_INVALID',
    'STATE_NAME_MISSING',
    'INITIAL_UNKNOWN',
    'ENDPOINT_UNKNOWN',
    'ACTION_MISSING',
    'TID_DUPLICATE',
    'INITIAL_MISSING',
    'ACTION_LIMIT',
  ]) {
    assert.ok(codes.includes(code), `应报告 ${code}；实际 ${JSON.stringify(codes)}`);
  }
  // 两侧问题都要收集
  assert.ok(r.errors.some((e) => e.side === 'A'));
  assert.ok(r.errors.some((e) => e.side === 'B'));
  // 清除旧结论：无轮次、无淘汰对、无初始对
  assert.equal(r.rounds.length, 0);
  assert.equal(r.eliminatedPairs.length, 0);
  assert.equal(r.firstEliminated, null);
  assert.equal(r.initialPairs.length, 0);
});

test('稳定排序：首个失败动作按动作字典序（tau 最后），轮次内状态对稳定排序', () => {
  const A = {
    states: [{ name: 's' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 'z', from: 's', action: 'z', to: 'p' },
      { id: 'b', from: 's', action: 'b', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 'c', from: 'q', action: 'c', to: 'r' }],
  };
  const r = audit(A, B);
  // 首个淘汰对按状态对字典序为 (p,q)：p 为死态，q 可做 c，首个失败动作为 c（B 挑战）
  assert.deepEqual(r.firstEliminated.pair, ['p', 'q']);
  assert.equal(r.firstEliminated.action, 'c');
  assert.equal(r.firstEliminated.challenger, 'B');
  // (s,q) 的首个失败义务才是动作 b（A 挑战，字典序早于 z）
  const sq = r.eliminatedPairs.find((p) => p.pair[0] === 's' && p.pair[1] === 'q');
  assert.equal(sq.action, 'b');
  assert.equal(sq.challenger, 'A');
  for (const rd of r.rounds) {
    const pairs = rd.eliminated.map((e) => e.pair.join(','));
    assert.deepEqual(pairs, [...pairs].sort());
  }
});

test('同构进程（仅状态重命名）等价', () => {
  const mk = (prefix) => ({
    states: [{ name: `${prefix}0` }, { name: `${prefix}1` }, { name: `${prefix}2` }],
    initial: `${prefix}0`,
    transitions: [
      { id: `${prefix}a`, from: `${prefix}0`, action: 'a', to: `${prefix}1` },
      { id: `${prefix}b`, from: `${prefix}1`, action: 'b', to: `${prefix}2` },
      { id: `${prefix}t`, from: `${prefix}2`, action: 'tau', to: `${prefix}0` },
    ],
  });
  const r = audit(mk('s'), mk('q'));
  assert.equal(r.equivalent, true);
  // 静默环使各状态经 tau 弱可达彼此：行为相同的非初始配对也可在关系中，
  // 关键是两个初始状态对均存活、初始对未被淘汰
  assert.ok(!r.eliminatedPairs.some((p) => p.pair[0] === 's0' && p.pair[1] === 'q0'));
});

test('状态数与可观察动作种类上限', () => {
  const tooMany = {
    states: Array.from({ length: 19 }, (_, i) => ({ name: `s${i}` })),
    initial: 's0',
    transitions: [],
  };
  const r1 = audit(tooMany, { states: [{ name: 'q' }], initial: 'q', transitions: [] });
  assert.ok(r1.errors.some((e) => e.code === 'STATE_LIMIT'));

  const fiveActions = {
    states: [{ name: 's' }],
    initial: 's',
    transitions: ['a', 'b', 'c', 'd', 'e'].map((a) => ({ id: a, from: 's', action: a, to: 's' })),
  };
  const r2 = audit(fiveActions, { states: [{ name: 'q' }], initial: 'q', transitions: [] });
  assert.ok(r2.errors.some((e) => e.code === 'ACTION_LIMIT'));
});

test('18 状态 4 动作的上限边界可正常计算', () => {
  const mk = (prefix) => ({
    states: Array.from({ length: 18 }, (_, i) => ({ name: `${prefix}${i}` })),
    initial: `${prefix}0`,
    transitions: [
      ...['a', 'b', 'c', 'd'].map((act, i) => ({ id: `${prefix}${act}`, from: `${prefix}0`, action: act, to: `${prefix}${i + 1}` })),
      { id: `${prefix}tau`, from: `${prefix}0`, action: 'tau', to: `${prefix}0` },
    ],
  });
  const r = audit(mk('s'), mk('q'));
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, true);
});
