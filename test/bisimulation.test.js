'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { audit, weakTargets, normalize, responseRoute, TAU } = require('../src/bisimulation');
const { samples } = require('../src/samples');

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

test('静默前缀 + 后继不匹配：初始对第 2 轮淘汰，候选响应逐步连续且每步对应已录入迁移', () => {
  const r = audit(samples.silentPrefix.procA, samples.silentPrefix.procB);
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, false);

  // 初始对淘汰轮次：(a0,b0) 在第 2 轮（第 1 轮先淘汰落点对 (a1,b2) 与 (a2,b2) 等）
  const p00 = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.ok(p00);
  assert.equal(p00.round, 2);
  assert.equal(p00.action, 'x');
  assert.equal(p00.challenger, 'A');
  assert.equal(p00.responder, 'B');
  assert.equal(r.initialAlive[0], false);

  // 挑战转移 A.a0 --x--> a1 的候选响应必须是实际连续路径：
  // b0 --tau--> b1（bt）承接 x：b1 --x--> b2（bx），不得伪造 b0 --x--> b2
  const fail = p00.transitions.find((t) => t.source === 'a1');
  assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
  assert.equal(fail.responses.length, 1);
  const w = fail.responses[0];
  assert.equal(w.target, 'b2');
  assert.deepEqual(w.pair, ['a1', 'b2']);
  assert.equal(w.eliminatedRound, 1);
  assert.equal(w.route.kind, 'WEAK');
  assert.deepEqual(w.route.steps, [
    { from: 'b0', action: 'tau', to: 'b1', transitionId: 'bt' },
    { from: 'b1', action: 'x', to: 'b2', transitionId: 'bx' },
  ]);

  // 全量不变量：所有候选响应路径逐步连续，且每步对应已录入迁移
  assertAllRoutesValid(r, [samples.silentPrefix.procA, samples.silentPrefix.procB]);
});

test('候选响应路径：含多个静默前缀与分叉候选时确定且可复算', () => {
  const procB = {
    states: [{ name: 'b0' }, { name: 'b1' }, { name: 'b2' }, { name: 'b3' }, { name: 'b4' }, { name: 'b5' }],
    initial: 'b0',
    transitions: [
      { id: 't-z', from: 'b0', action: 'tau', to: 'b1' },
      { id: 't-a', from: 'b0', action: 'tau', to: 'b1' }, // 平行 tau，取最小标识
      { id: 't-b2', from: 'b0', action: 'tau', to: 'b2' },
      { id: 't-b4', from: 'b0', action: 'tau', to: 'b4' },
      { id: 't-b5', from: 'b4', action: 'tau', to: 'b5' }, // 更长的静默前缀
      { id: 'x-b1', from: 'b1', action: 'x', to: 'b3' },
      { id: 'x-b2', from: 'b2', action: 'x', to: 'b3' },
      { id: 'x-b5', from: 'b5', action: 'x', to: 'b3' },
    ],
  };
  const p = normalize(procB);
  const expect = [
    { from: 'b0', action: 'tau', to: 'b1', transitionId: 't-a' },
    { from: 'b1', action: 'x', to: 'b3', transitionId: 'x-b1' },
  ];
  for (let i = 0; i < 20; i += 1) {
    const route = responseRoute(p, 'b0', 'x', 'b3');
    assert.deepEqual(route.steps, expect); // 最短前缀 → 落点字典序 → 最小迁移标识
  }
  // 直达动作仍为 DIRECT
  assert.equal(responseRoute(p, 'b2', 'x', 'b3').kind, 'DIRECT');
  // tau 弱转移走实际 tau 链
  assert.deepEqual(responseRoute(p, 'b0', 'tau', 'b5').steps, [
    { from: 'b0', action: 'tau', to: 'b4', transitionId: 't-b4' },
    { from: 'b4', action: 'tau', to: 'b5', transitionId: 't-b5' },
  ]);
});

test('路径还原与规程侧无关：tau 前缀规程作为 A 侧时同样还原连续路径', () => {
  // 与 silentPrefix 镜像：此处 tau 前缀规程作为被直接调用 responseRoute 的一方，
  // 证明还原逻辑不依赖 A/B 侧位置。
  const procA = {
    states: [{ name: 'a0' }, { name: 'a1' }, { name: 'a2' }, { name: 'a3' }],
    initial: 'a0',
    transitions: [
      { id: 'at', from: 'a0', action: 'tau', to: 'a1' },
      { id: 'ax', from: 'a1', action: 'x', to: 'a2' },
      { id: 'ap', from: 'a2', action: 'p', to: 'a3' },
    ],
  };
  const p = normalize(procA);
  assert.deepEqual(responseRoute(p, 'a0', 'x', 'a2').steps, [
    { from: 'a0', action: 'tau', to: 'a1', transitionId: 'at' },
    { from: 'a1', action: 'x', to: 'a2', transitionId: 'ax' },
  ]);

  // 镜像输入整体审计仍判不等价，初始对第 2 轮淘汰，裁决与轮次不随侧别改变
  const procB = {
    states: [{ name: 'b0' }, { name: 'b1' }, { name: 'b2' }],
    initial: 'b0',
    transitions: [
      { id: 'bx', from: 'b0', action: 'x', to: 'b1' },
      { id: 'bq', from: 'b1', action: 'q', to: 'b2' },
    ],
  };
  const r = audit(procA, procB);
  assert.equal(r.equivalent, false);
  const p00 = r.eliminatedPairs.find((x) => x.pair[0] === 'a0' && x.pair[1] === 'b0');
  assert.equal(p00.round, 2);
  assert.equal(p00.action, 'x');
  assertAllRoutesValid(r, [procA, procB]);
});

// 路径不变量：逐步连续（起点=应答方状态、上一步落点=下一步起点、末点=落点），
// 且每一步（含迁移标识）都对应该应答侧一条已录入迁移；动作仅末步可为可观察动作。
function assertAllRoutesValid(r, specs) {
  const edgeIndex = specs.map((spec) => {
    const m = new Map();
    for (const t of spec.transitions) {
      const k = [t.from, t.action, t.to].join('|');
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t.id);
    }
    return m;
  });
  for (const ep of r.eliminatedPairs) {
    if (!ep.transitions.some((t) => t.reason === 'ALL_RESPONSES_ELIMINATED')) continue;
    const sideIdx = ep.responder === 'A' ? 0 : 1;
    const responderState = ep.responder === 'A' ? ep.pair[0] : ep.pair[1];
    const edges = edgeIndex[sideIdx];
    for (const t of ep.transitions) {
      if (t.reason !== 'ALL_RESPONSES_ELIMINATED') continue;
      for (const w of t.responses) {
        const steps = w.route.steps;
        assert.ok(Array.isArray(steps), `路径步骤应为数组：${JSON.stringify(w.route)}`);
        if (steps.length === 0) {
          // 零步仅允许自反 tau 弱转移（IDLE）：起点即落点
          assert.equal(w.route.kind, 'IDLE');
          assert.equal(w.route.start, w.route.end);
          assert.equal(w.route.end, w.target);
          continue;
        }
        assert.equal(steps[0].from, responderState, '路径必须从应答方状态起步');
        assert.equal(steps[0].from, w.route.start);
        assert.equal(steps[steps.length - 1].to, w.route.end);
        assert.equal(w.route.end, w.target);
        for (let i = 1; i < steps.length; i += 1) {
          assert.equal(steps[i - 1].to, steps[i].from, '路径必须逐步连续');
        }
        for (let i = 0; i < steps.length; i += 1) {
          const s = steps[i];
          const isLast = i === steps.length - 1;
          if (!isLast) assert.equal(s.action, 'tau', '静默前缀只能由 tau 组成');
          const ids = edges.get([s.from, s.action, s.to].join('|'));
          assert.ok(ids, `路径步骤不在应答侧已录入迁移中：${JSON.stringify(s)}`);
          if (s.transitionId != null) assert.ok(ids.includes(s.transitionId), `迁移标识无法定位：${JSON.stringify(s)}`);
        }
        if (w.route.action === 'tau') assert.equal(w.route.kind, 'WEAK');
        else if (steps.length === 1) assert.equal(w.route.kind, 'DIRECT');
        else assert.equal(w.route.kind, 'WEAK');
      }
    }
  }
}

test('tau 义务的零步自反响应为 IDLE；非零 tau 路径仍逐步回放', () => {
  const p = normalize({
    states: [{ name: 's' }, { name: 'u' }, { name: 'v' }],
    initial: 's',
    transitions: [
      { id: 't1', from: 's', action: 'tau', to: 'u' },
      { id: 't2', from: 'u', action: 'tau', to: 'v' },
    ],
  });
  assert.deepEqual(responseRoute(p, 's', 'tau', 's'), {
    start: 's', end: 's', action: 'tau', kind: 'IDLE', steps: [],
  });
  assert.equal(responseRoute(p, 's', 'tau', 'u').kind, 'WEAK');
  assert.deepEqual(responseRoute(p, 's', 'tau', 'v').steps, [
    { from: 's', action: 'tau', to: 'u', transitionId: 't1' },
    { from: 'u', action: 'tau', to: 'v', transitionId: 't2' },
  ]);

  // 审计中以 tau 为首个失败义务时，自反候选响应不产生伪造步骤且整体可复算
  const A = {
    states: [{ name: 's' }, { name: 'a' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 't', from: 's', action: 'tau', to: 'a' },
      { id: 'x', from: 's', action: 'x', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 'x', from: 'q', action: 'x', to: 'r' }],
  };
  const r = audit(A, B);
  assert.equal(r.equivalent, false);
  const sq = r.eliminatedPairs.find((e) => e.pair[0] === 's' && e.pair[1] === 'q');
  assert.equal(sq.action, 'tau');
  const w = sq.transitions[0].responses[0];
  assert.equal(w.route.kind, 'IDLE');
  assert.deepEqual(w.route.steps, []);
  assertAllRoutesValid(r, [A, B]);
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
