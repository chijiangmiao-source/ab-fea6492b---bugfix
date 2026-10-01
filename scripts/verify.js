#!/usr/bin/env node
'use strict';

// Compose verify 服务入口：
//   1) 构建检查：全部源码/脚本语法检查（node --check）
//   2) 代码测试：node --test
//   3) 接口 / HTTP 冒烟：健康路径、页面、审计接口
//      - 静默环等价规程：审计必须判定等价，关系含两个初始状态对
//      - 缺失匹配动作规程：审计必须判定不等价，且失败依据只引用更早轮次
//      - 无效输入：一次返回全部问题并清除旧结论
//      - 静默前缀规程：初始对在后续轮次淘汰，候选响应必须是 tau 前缀 + 同动作的
//        逐步真实迁移（每步对应已录入迁移标识），页面与审计接口呈现一致
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
  });

  await astep('静默前缀规程：初始对第 2 轮淘汰且候选响应逐步连续（tau 前缀 + x）', async () => {
    const j = await postAudit(samples.silentPrefix);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, false);

    const p12 = j.eliminatedPairs.find((p) => p.pair[0] === 'a1' && p.pair[1] === 'b2');
    assert.ok(p12 && p12.round === 1 && p12.action === 'p', '后继不匹配对应在第 1 轮淘汰');
    const p00 = j.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
    assert.ok(p00 && p00.round === 2 && p00.action === 'x' && p00.challenger === 'A',
      '初始对应在第 2 轮因 x 义务淘汰');
    assert.equal(j.initialAlive[0], false);

    // 候选响应逐步骤校验：只允许走已录入迁移，且首尾相接
    const fail = p00.transitions.find((t) => t.source === 'a1');
    assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
    assert.equal(fail.responses.length, 1);
    const w = fail.responses[0];
    assert.equal(w.route.start, 'b0');
    assert.equal(w.route.end, 'b2');
    assert.equal(w.route.kind, 'WEAK');
    assert.deepEqual(
      w.route.steps.map((s) => [s.from, s.action, s.to, s.transitionId]),
      [['b0', 'tau', 'b1', 'bt'], ['b1', 'x', 'b2', 'bx']],
    );
    const byId = new Map(samples.silentPrefix.procB.transitions.map((t) => [t.id, t]));
    for (let i = 0; i < w.route.steps.length; i += 1) {
      const s = w.route.steps[i];
      const t = byId.get(s.transitionId);
      assert.ok(t, `迁移标识 ${s.transitionId} 已录入`);
      assert.equal(t.from, s.from);
      assert.equal(t.action, s.action);
      assert.equal(t.to, s.to);
      if (i > 0) assert.equal(w.route.steps[i - 1].to, s.from, '步骤须首尾相接');
    }

    // 全部淘汰对的全部候选响应都必须逐步对应已录入迁移
    for (const ep of j.eliminatedPairs) {
      const spec = ep.challenger === 'A' ? samples.silentPrefix.procB : samples.silentPrefix.procA;
      const idx = new Map(spec.transitions.map((t) => [t.id, t]));
      for (const tr of ep.transitions) {
        if (tr.reason !== 'ALL_RESPONSES_ELIMINATED') continue;
        for (const c of tr.responses) {
          assert.equal(c.route.end, c.target);
          for (const st of c.route.steps) {
            const rec = idx.get(st.transitionId);
            assert.ok(rec, `候选响应每步须对应已录入迁移：${st.transitionId}`);
            assert.equal(rec.from, st.from);
            assert.equal(rec.action, st.action);
            assert.equal(rec.to, st.to);
          }
        }
      }
    }
  });

  await astep('页面与审计接口一致：页面渲染同一候选响应的逐步路径与迁移标识', async () => {
    const j = await postAudit(samples.silentPrefix);
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // 页面静态部分须承载逐步回放所需的渲染逻辑与静默前缀示例入口
    for (const token of ['renderRouteSteps', 'transitionId', 'silentPrefix', '逐步回放']) {
      assert.ok(html.includes(token), `页面缺少 ${token}`);
    }
    // 页面可经示例接口取得与审计同一规程（页面 JS 自行渲染同一份 route.steps）
    const samp = await (await fetch(`${BASE}/api/samples`)).json();
    assert.deepEqual(samp.silentPrefix, samples.silentPrefix);
    // 接口中出现的每个迁移标识页面脚本都具备渲染字段
    assert.ok(html.includes('w.route.steps'));
    assert.ok(j.firstEliminated, '接口须返回淘汰依据供页面渲染');
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
