#!/usr/bin/env node
'use strict';

// Compose verify 服务入口：
//   1) 构建检查：全部源码/脚本语法检查（node --check）
//   2) 代码测试：node --test
//   3) 接口 / HTTP 冒烟：健康路径、页面、审计接口
//      - 静默环等价规程：审计必须判定等价，关系含两个初始状态对
//      - 静默前缀 + 后继不匹配规程：初始对第 2 轮淘汰，候选响应必须逐步连续
//        （tau 前缀后承接同动作），每步对应已录入迁移；页面与接口契约一致
//      - 直接动作 / 级联淘汰：直达候选响应为 DIRECT 单步，失败依据只引用更早轮次
//      - 缺失匹配动作规程：审计必须判定不等价
//      - 无效输入：一次返回全部问题并清除旧结论
// 完成后退出：全部通过 0，任一失败 1。

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { samples } = require('../src/samples');

const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:8080';
const ROOT = path.join(__dirname, '..');

let failures = 0;
function step(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(String(e && e.stack || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}
async function astep(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(String(e && e.stack || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listJs(p) : d.name.endsWith('.js') ? [p] : [];
  });
}

// ---------- 1) 构建检查 ----------
console.log('[1/3] 构建检查（node --check）');
for (const file of [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'scripts')), ...listJs(path.join(ROOT, 'test'))]) {
  step(`语法检查 ${path.relative(ROOT, file)}`, () => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || 'node --check 失败');
  });
}

// ---------- 2) 代码测试 ----------
console.log('[2/3] 代码测试（node --test）');
step('node --test 全部通过', () => {
  const r = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = (r.stdout || '').split('\n').slice(-25).join('\n');
    throw new Error(`测试失败（退出码 ${r.status}）:\n${tail}`);
  }
});

// ---------- 3) 接口 / HTTP 冒烟 ----------
console.log(`[3/3] 接口 / HTTP 冒烟（${BASE}）`);

async function waitReady(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：${lastErr && lastErr.message}`);
}

async function postAudit(body) {
  const res = await fetch(`${BASE}/api/audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `审计接口 HTTP 状态应为 200，实际 ${res.status}`);
  return res.json();
}

// 复算不变量：候选响应必须逐步连续（起点=应答方状态、上一步落点=下一步起点、
// 末点=响应落点），每一步（含迁移标识）都对应该应答侧一条已录入迁移；
// 除末步承接同动作外，前缀只能由 tau 组成。
function validateRoutesRecorded(j, specs) {
  const edgeIndex = specs.map((spec) => {
    const m = new Map();
    for (const t of spec.transitions) {
      const k = `${t.from}|${t.action}|${t.to}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t.id);
    }
    return m;
  });
  for (const ep of j.eliminatedPairs) {
    if (!ep.transitions.some((t) => t.reason === 'ALL_RESPONSES_ELIMINATED')) continue;
    const sideIdx = ep.responder === 'A' ? 0 : 1;
    const responderState = ep.responder === 'A' ? ep.pair[0] : ep.pair[1];
    const edges = edgeIndex[sideIdx];
    for (const t of ep.transitions) {
      if (t.reason !== 'ALL_RESPONSES_ELIMINATED') continue;
      for (const w of t.responses) {
        const steps = w.route.steps;
        assert.ok(Array.isArray(steps), `候选响应步骤应为数组：${JSON.stringify(w.route)}`);
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
          assert.equal(steps[i - 1].to, steps[i].from, '候选响应必须逐步连续');
        }
        steps.forEach((s, i) => {
          if (i < steps.length - 1) assert.equal(s.action, 'tau', '静默前缀只能由 tau 组成');
          const ids = edges.get(`${s.from}|${s.action}|${s.to}`);
          assert.ok(ids, `路径步骤不在应答侧已录入迁移中：${JSON.stringify(s)}`);
          assert.ok(s.transitionId && ids.includes(s.transitionId),
            `迁移标识无法定位已录入迁移：${JSON.stringify(s)}，候选 ${JSON.stringify(ids)}`);
        });
      }
    }
  }
}

(async () => {
  await astep('服务健康检查就绪 GET /healthz', async () => {
    await waitReady(BASE);
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, 'ok');
  });

  await astep('页面 GET / 返回 HTML', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('弱互模拟审计'));
  });

  await astep('示例接口 GET /api/samples 包含等价与缺失规程', async () => {
    const res = await fetch(`${BASE}/api/samples`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.equivalent && j.missing);
  });

  await astep('静默环等价规程：判定等价且关系含两个初始状态对', async () => {
    const j = await postAudit(samples.equivalent);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, true, JSON.stringify(j.eliminatedPairs));
    assert.equal(j.initialPairs.length, 2);
    assert.deepEqual(j.initialPairs, [['S0', 'P0'], ['P0', 'S0']]);
    assert.ok(j.initialAlive.every(Boolean));
  });

  await astep('缺失匹配动作规程：判定不等价，首个失败动作为 x', async () => {
    const j = await postAudit(samples.missing);
    assert.equal(j.equivalent, false);
    assert.ok(j.firstEliminated, '应给出首个淘汰状态对');
    assert.equal(j.firstEliminated.action, 'x');
    assert.ok(j.firstEliminated.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));
    assert.equal(j.initialAlive[0], false);
  });

  await astep('多轮级联规程：失败义务只引用更早轮次淘汰结果且按轮次递减', async () => {
    const j = await postAudit(samples.cascade);
    assert.equal(j.equivalent, false);
    for (const ep of j.eliminatedPairs) {
      for (const t of ep.transitions) {
        if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
          for (const w of t.responses) {
            assert.ok(Number.isInteger(w.eliminatedRound) && w.eliminatedRound < ep.round);
          }
          const rounds = t.responses.map((w) => w.eliminatedRound);
          assert.deepEqual(rounds, [...rounds].sort((a, b) => b - a), '依据应按轮次递减');
        }
      }
    }
    // 直达候选响应：单步 DIRECT，迁移标识可在已录入迁移中定位
    const p00 = j.eliminatedPairs.find((e) => e.pair[0] === 'a0' && e.pair[1] === 'b0');
    const fail = p00.transitions.find((t) => t.source === 'a1');
    assert.equal(fail.responses.length, 1);
    const route = fail.responses[0].route;
    assert.equal(route.kind, 'DIRECT');
    assert.deepEqual(route.steps, [{ from: 'b0', action: 'x', to: 'b1', transitionId: 'bx' }]);
  });

  await astep('静默前缀+后继不匹配：初始对第 2 轮淘汰，候选响应逐步连续（tau→x）且对应已录入迁移', async () => {
    const j = await postAudit(samples.silentPrefix);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, false);

    const p00 = j.eliminatedPairs.find((e) => e.pair[0] === 'a0' && e.pair[1] === 'b0');
    assert.ok(p00, '应存在初始状态对淘汰记录');
    assert.equal(p00.round, 2, '初始对应在第 2 轮淘汰');
    assert.equal(p00.action, 'x');
    assert.equal(p00.challenger, 'A');
    assert.equal(j.initialAlive[0], false);

    const fail = p00.transitions.find((t) => t.source === 'a1');
    assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
    assert.equal(fail.responses.length, 1);
    const w = fail.responses[0];
    assert.equal(w.target, 'b2');
    assert.deepEqual(w.pair, ['a1', 'b2']);
    assert.equal(w.eliminatedRound, 1);
    // 实际连续候选响应：先内部跳转 bt，再承接同动作 bx；不得出现伪造的 b0 --x--> b2
    assert.deepEqual(w.route.steps, [
      { from: 'b0', action: 'tau', to: 'b1', transitionId: 'bt' },
      { from: 'b1', action: 'x', to: 'b2', transitionId: 'bx' },
    ]);
    assert.equal(w.route.kind, 'WEAK');

    // 全量复算：全部候选路径逐步连续，且每一步（含迁移标识）都在已录入迁移中
    validateRoutesRecorded(j, [samples.silentPrefix.procA, samples.silentPrefix.procB]);
  });

  await astep('页面与审计接口一致：页面按 route.steps/transitionId 逐步回放候选响应', async () => {
    // 接口返回
    const j = await postAudit(samples.silentPrefix);
    // 页面契约：渲染逻辑消费与接口相同的字段，且不再存在伪造直达的单步拼接
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const token of ['renderRouteSteps', 'route.steps', 's.transitionId', '候选响应路径']) {
      assert.ok(html.includes(token), `页面应包含逐步回放契约字段：${token}`);
    }
    // 页面脚本对每个候选响应逐行输出步骤；接口中所有响应路径字段完整
    for (const ep of j.eliminatedPairs) {
      for (const t of ep.transitions) {
        if (t.reason !== 'ALL_RESPONSES_ELIMINATED') continue;
        for (const w of t.responses) {
          assert.ok(Array.isArray(w.route.steps) && w.route.steps.length >= 1);
          for (const s of w.route.steps) {
            for (const k of ['from', 'action', 'to', 'transitionId']) {
              assert.ok(Object.prototype.hasOwnProperty.call(s, k), `路径步骤缺字段 ${k}`);
            }
          }
        }
      }
    }
  });

  await astep('无效输入：一次返回全部问题并清除旧结论', async () => {
    const bad = {
      procA: { states: [{ name: 's' }, { name: 's' }], initial: 'ghost', transitions: [{ id: 't1', from: 's', action: '', to: 'x' }] },
      procB: { states: [], initial: '', transitions: [] },
    };
    const j = await postAudit(bad);
    assert.equal(j.ok, false);
    assert.equal(j.equivalent, null);
    assert.ok(j.errors.length >= 4, () => `应一次报告所有问题，实际 ${j.errors.length}`);
    assert.deepEqual(j.rounds, []);
    assert.deepEqual(j.eliminatedPairs, []);
    assert.equal(j.firstEliminated, null);
  });

  await astep('非 JSON 请求体返回 400', async () => {
    const res = await fetch(`${BASE}/api/audit`, { method: 'POST', body: 'not-json' });
    assert.equal(res.status, 400);
  });

  console.log(failures === 0 ? '\nVERIFY RESULT: PASS' : `\nVERIFY RESULT: FAIL（${failures} 项）`);
  process.exit(failures === 0 ? 0 : 1);
})();
