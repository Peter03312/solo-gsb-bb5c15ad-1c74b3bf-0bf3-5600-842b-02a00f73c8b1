import * as assert from 'assert';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { createApp } from './app';
import { initSchema } from './db';

// 使用真实 PostgreSQL 语义（PGlite / WASM）端到端校验全部业务规则。
async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  await initSchema();
  const server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let seq = 0;
async function call(
  base: string,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function expectFail(r: { status: number; json: any }, status: number, phrase: string) {
  assert.strictEqual(r.status, status, `期望 ${status}，实际 ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok(
    JSON.stringify(r.json).includes(phrase),
    `错误信息应包含「${phrase}」，实际：${JSON.stringify(r.json)}`
  );
}

async function main() {
  const { base, close } = await startServer();
  try {
    // ---------- 建档 ----------
    let r = await call(base, 'POST', '/documents', {
      title: `集成测试文献 ${++seq}`,
      manuscripts: ['甲本', '乙本', '丙本'],
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const docId = r.json.id;

    let view = (await call(base, 'GET', `/documents/${docId}`)).json;
    const v1 = view.document.version;
    assert.strictEqual(v1, 1);
    const [msA, msB, msC] = view.manuscripts;
    assert.strictEqual(msA.name, '甲本');
    assert.ok(msA.isBase, '第一份抄本应为默认底本');

    // ---------- 逐行录文 ----------
    // 甲本（底本）：
    //  行1 天命之謂性率性之謂道
    //  行2 修道之謂教
    // 乙本：
    //  行1 天命之謂姓率性之謂道
    //  行2 修道之謂教也
    // 丙本：
    //  行1 天命之謂性
    //  行2 修道之謂教
    await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: v1, content: '天命之謂性率性之謂道' });
    await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: 2, content: '修道之謂教' });
    await call(base, 'POST', `/manuscripts/${msB.id}/lines`, { expectedVersion: 3, content: '天命之謂姓率性之謂道' });
    await call(base, 'POST', `/manuscripts/${msB.id}/lines`, { expectedVersion: 4, content: '修道之謂教也' });
    await call(base, 'POST', `/manuscripts/${msC.id}/lines`, { expectedVersion: 5, content: '天命之謂性' });
    await call(base, 'POST', `/manuscripts/${msC.id}/lines`, { expectedVersion: 6, content: '修道之謂教' });
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    const v7 = view.document.version;
    assert.strictEqual(v7, 7);

    const lines = (msId: number) => view.rawByMs.find((x: any) => x.msId === msId).lines;
    const a1 = lines(msA.id)[0].lineId;
    const a2 = lines(msA.id)[1].lineId;
    const b1 = lines(msB.id)[0].lineId;
    const b2 = lines(msB.id)[1].lineId;
    const c1 = lines(msC.id)[0].lineId;
    const c2 = lines(msC.id)[1].lineId;

    // ---------- 归组：合法整批 ----------
    const goodGroups = [
      // 组1 天命之謂性 / 天命之謂姓（异文）/ 天命之謂性
      { ord: 1, fragments: [
        { msId: msA.id, lineId: a1, startCp: 0, endCp: 5 },
        { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
        { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
      ]},
      // 组2 率性之謂道 / 率性之謂道 / 缺文
      { ord: 2, fragments: [
        { msId: msA.id, lineId: a1, startCp: 5, endCp: 10 },
        { msId: msB.id, lineId: b1, startCp: 5, endCp: 10 },
        { msId: msC.id, missing: true },
      ]},
      // 组3 修道之謂教（三者同文；丙本行2）
      { ord: 3, fragments: [
        { msId: msA.id, lineId: a2, startCp: 0, endCp: 5 },
        { msId: msB.id, lineId: b2, startCp: 0, endCp: 5 },
        { msId: msC.id, lineId: c2, startCp: 0, endCp: 5 },
      ]},
    ];
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: v7, groups: goodGroups });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.groupCount, 3);
    assert.strictEqual(view.stats.brokenCount, 0);
    assert.strictEqual(view.groups[0].variant, true, '性/姓应为异文');
    assert.strictEqual(view.groups[0].baseText, '天命之謂性');
    assert.strictEqual(view.groups[1].hasMissing, true, '丙本缺文');
    assert.strictEqual(view.groups[2].variant, false);

    // 未归组文字仍可见：乙本行2「也」无覆盖
    const b2view = view.rawByMs.find((x: any) => x.msId === msB.id).lines[1];
    assert.strictEqual(b2view.covered.length, 1);
    assert.strictEqual(b2view.covered[0].endCp, 5);

    // ---------- 错误：越界片段（须指出位置，不保存） ----------
    const badRange = JSON.parse(JSON.stringify(goodGroups));
    badRange[1].fragments[1] = { msId: msB.id, lineId: b1, startCp: 5, endCp: 99 };
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: badRange });
    await expectFail(r, 400, '越界');
    assert.ok(r.json.details.some((d: any) => d.code === 'OUT_OF_RANGE' && d.lineNo === 1));

    // ---------- 错误：同一抄本重叠归组 ----------
    const overlap = JSON.parse(JSON.stringify(goodGroups));
    overlap[0].fragments[1] = { msId: msB.id, lineId: b1, startCp: 0, endCp: 6 }; // 与组2 [5,10) 重叠
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: overlap });
    await expectFail(r, 400, '重叠归组');
    assert.ok(r.json.details.some((d: any) => d.code === 'OVERLAP'));

    // ---------- 错误：缺少底本片段 ----------
    const noBase = JSON.parse(JSON.stringify(goodGroups));
    noBase[0].fragments = noBase[0].fragments.filter((f: any) => f.msId !== msA.id);
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: noBase });
    await expectFail(r, 400, '缺少底本片段');
    assert.ok(r.json.details.some((d: any) => d.code === 'NO_BASE'));

    // ---------- 错误：底本片段被标缺文 ----------
    const baseMissing = JSON.parse(JSON.stringify(goodGroups));
    baseMissing[0].fragments[0] = { msId: msA.id, missing: true };
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: baseMissing });
    await expectFail(r, 400, '底本片段被标为缺文');

    // ---------- 错误：同组同抄本两个片段 ----------
    const dupMs = JSON.parse(JSON.stringify(goodGroups));
    dupMs[0].fragments.push({ msId: msB.id, lineId: b1, startCp: 8, endCp: 9 });
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: view.document.version, groups: dupMs });
    await expectFail(r, 400, '出现多个片段');

    // ---------- 错误：不能部分保存 —— 校验失败后已保存数据保持 3 组完好 ----------
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.groupCount, 3);
    assert.strictEqual(view.stats.brokenCount, 0);

    // ---------- 乐观锁：过期版本拒绝 ----------
    r = await call(base, 'PUT', `/documents/${docId}/groups`, { expectedVersion: v7, groups: goodGroups });
    await expectFail(r, 409, '版本已过期');
    r = await call(base, 'POST', `/manuscripts/${msA.id}/lines`, { expectedVersion: 1, content: '过期请求' });
    await expectFail(r, 409, '版本已过期');

    // ---------- 改原文：只使受影响组待修复 ----------
    // 乙本行1「天命之謂姓率性之謂道」把「姓」改为「性」（[4,5)），与组1相交
    r = await call(base, 'PUT', `/lines/${b1}`, { expectedVersion: view.document.version, startCp: 4, endCp: 5, replacement: '性' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 1, '仅组1受影响');
    assert.strictEqual(view.groups[0].broken, true);
    assert.strictEqual(view.groups[1].broken, false);
    assert.strictEqual(view.groups[2].broken, false);
    const curVer = view.document.version;

    // 待修复期间不得发布
    r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: curVer });
    await expectFail(r, 409, '待修复');

    // ---------- 修复组1（异文消失） ----------
    const g1id = view.groups[0].id;
    r = await call(base, 'PUT', `/documents/${docId}/groups/${g1id}/repair`, {
      expectedVersion: curVer,
      group: { ord: 1, fragments: [
        { msId: msA.id, lineId: a1, startCp: 0, endCp: 5 },
        { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
        { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
      ]},
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 0);
    assert.strictEqual(view.groups[0].variant, false, '改字后甲乙一致，不再是异文');

    // 修复时与其他组重叠 → 拒绝
    r = await call(base, 'PUT', `/documents/${docId}/groups/${g1id}/repair`, {
      expectedVersion: view.document.version,
      group: { ord: 1, fragments: [
        { msId: msA.id, lineId: a1, startCp: 0, endCp: 6 }, // 与组2 [5,10) 重叠
        { msId: msB.id, lineId: b1, startCp: 0, endCp: 5 },
        { msId: msC.id, lineId: c1, startCp: 0, endCp: 5 },
      ]},
    });
    await expectFail(r, 400, '重叠归组');
    // 失败的修复不得改动既有状态
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 0);

    // ---------- 插入导致后方片段平移（不受影响、不待修复） ----------
    // 乙本行2「修道之謂教也」：在开头插入「曰」[0,0)。组3片段 [0,5) 与插入点端点相接（不相交）→ 平移到 [1,6)
    r = await call(base, 'PUT', `/lines/${b2}`, { expectedVersion: view.document.version, startCp: 0, endCp: 0, replacement: '曰' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 0, '端点相接的插入不应使组待修复');
    const b2cell = view.groups[2].cells.find((c: any) => c.msId === msB.id);
    assert.strictEqual(b2cell.text, '修道之謂教', '平移后截取文字不变');
    assert.strictEqual(b2cell.startCp, 1);
    assert.strictEqual(b2cell.endCp, 6);

    // ---------- 缩短导致越界 → 待修复，且修复前不得发布 ----------
    // 把甲本行1删到只剩 3 字：组1 [0,5)、组2 [5,10) 都失效
    r = await call(base, 'PUT', `/lines/${a1}`, { expectedVersion: view.document.version, startCp: 3, endCp: 10, replacement: '' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.stats.brokenCount, 2);
    r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
    await expectFail(r, 409, '不得发布');

    // 恢复原文（重新追加），再修复两组
    r = await call(base, 'PUT', `/lines/${a1}`, { expectedVersion: view.document.version, startCp: 3, endCp: 3, replacement: '之謂性率性之謂道' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    // 追加后区间仍保持原样且重新有效？[0,5) 现在合法、[5,10) 合法 —— 但组仍被标 broken（只增不减）
    assert.strictEqual(view.stats.brokenCount, 2);
    for (const g of view.groups.filter((x: any) => x.broken)) {
      const cells = g.cells;
      const rebuild: any[] = [];
      for (const ms of view.manuscripts) {
        const cell = cells.find((c: any) => c.msId === ms.id);
        if (cell.missing) rebuild.push({ msId: ms.id, missing: true });
        else if (cell.startCp != null) {
          // 重新定位行 id（按行号）
          const ln = view.rawByMs.find((x: any) => x.msId === ms.id).lines.find((l: any) => l.lineNo === cell.lineNo);
          rebuild.push({ msId: ms.id, lineId: ln.lineId, startCp: cell.startCp, endCp: cell.endCp });
        }
      }
      const rr = await call(base, 'PUT', `/documents/${docId}/groups/${g.id}/repair`, {
        expectedVersion: view.document.version,
        group: { ord: g.ord, fragments: rebuild },
      });
      assert.strictEqual(rr.status, 200, JSON.stringify(rr.json));
      view = (await call(base, 'GET', `/documents/${docId}`)).json;
    }
    assert.strictEqual(view.stats.brokenCount, 0);

    // ---------- 发布 ----------
    r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.editionNo, 1);
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.strictEqual(view.document.publishedVer, 1);

    // 旧版可读（快照）
    const ed = (await call(base, 'GET', `/documents/${docId}/editions/1`)).json;
    assert.strictEqual(ed.view.document.title, view.document.title);
    assert.strictEqual(ed.view.groups.length, 3);
    const eds = (await call(base, 'GET', `/documents/${docId}/editions`)).json;
    assert.strictEqual(eds.editions.length, 1);

    // 发布后继续改原文 → 出现待修复，但旧版仍可读、且不允许发新版
    r = await call(base, 'PUT', `/lines/${a2}`, { expectedVersion: view.document.version, startCp: 0, endCp: 1, replacement: '脩' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    view = (await call(base, 'GET', `/documents/${docId}`)).json;
    assert.ok(view.stats.brokenCount >= 1);
    r = await call(base, 'POST', `/documents/${docId}/publish`, { expectedVersion: view.document.version });
    await expectFail(r, 409, '不得发布');
    const oldEd = await call(base, 'GET', `/documents/${docId}/editions/1`);
    assert.strictEqual(oldEd.status, 200, '旧发布版必须仍可阅读');

    // ---------- 倒置检测：另建一文献 ----------
    r = await call(base, 'POST', '/documents', { title: `倒置测试 ${++seq}`, manuscripts: ['底', 'W'] });
    assert.strictEqual(r.status, 201);
    const d2 = r.json.id;
    let v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    let ver = v2doc.document.version;
    const base2 = v2doc.manuscripts[0];
    const wit2 = v2doc.manuscripts[1];
    // 底：行1 AB；W：行1 BA
    await call(base, 'POST', `/manuscripts/${base2.id}/lines`, { expectedVersion: ver++, content: 'AB' });
    await call(base, 'POST', `/manuscripts/${wit2.id}/lines`, { expectedVersion: ver++, content: 'BA' });
    v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    const bl = v2doc.rawByMs.find((x: any) => x.msId === base2.id).lines[0].lineId;
    const wl = v2doc.rawByMs.find((x: any) => x.msId === wit2.id).lines[0].lineId;
    // 组1: 底 A / W 第2字；组2: 底 B / W 第1字 → W 中顺序倒置
    r = await call(base, 'PUT', `/documents/${d2}/groups`, {
      expectedVersion: ver,
      groups: [
        { ord: 1, fragments: [
          { msId: base2.id, lineId: bl, startCp: 0, endCp: 1 },
          { msId: wit2.id, lineId: wl, startCp: 1, endCp: 2 },
        ]},
        { ord: 2, fragments: [
          { msId: base2.id, lineId: bl, startCp: 1, endCp: 2 },
          { msId: wit2.id, lineId: wl, startCp: 0, endCp: 1 },
        ]},
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    assert.ok(v2doc.groups[0].inverted && v2doc.groups[1].inverted, '两组都应标倒置');

    // ---------- 切底本：不含新底本片段的组待修复 ----------
    // 给 d2 加第三个抄本 C 并切为底本（其行无任何片段）
    r = await call(base, 'POST', `/documents/${d2}/manuscripts`, { expectedVersion: v2doc.document.version, name: 'C' });
    assert.strictEqual(r.status, 201);
    v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    const cId3 = v2doc.manuscripts.find((m: any) => m.name === 'C').id;
    r = await call(base, 'PUT', `/documents/${d2}/base`, { expectedVersion: v2doc.document.version, msId: cId3 });
    assert.strictEqual(r.status, 200);
    v2doc = (await call(base, 'GET', `/documents/${d2}`)).json;
    assert.strictEqual(v2doc.stats.brokenCount, 2, '切换底本后原两组均缺新底本片段');

    // ---------- 版本对照：已发布校勘版 vs 当前工作版 ----------
    // 新建独立文献，避免受上面修复/改字流程干扰
    r = await call(base, 'POST', '/documents', { title: `版本对照测试 ${++seq}`, manuscripts: ['底甲', '乙', '丙'] });
    assert.strictEqual(r.status, 201);
    const d3 = r.json.id;
    let d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    let d3ver = d3v.document.version;
    const dmA = d3v.manuscripts[0]; // 底甲（默认底本）
    const dmB = d3v.manuscripts[1];
    const dmC = d3v.manuscripts[2];
    await call(base, 'POST', `/manuscripts/${dmA.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂性' });
    await call(base, 'POST', `/manuscripts/${dmB.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂姓' });
    await call(base, 'POST', `/manuscripts/${dmC.id}/lines`, { expectedVersion: d3ver++, content: '天命之謂性' });
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    const da1 = d3v.rawByMs.find((x: any) => x.msId === dmA.id).lines[0].lineId;
    const db1 = d3v.rawByMs.find((x: any) => x.msId === dmB.id).lines[0].lineId;
    const dc1 = d3v.rawByMs.find((x: any) => x.msId === dmC.id).lines[0].lineId;

    const groupsV1 = [
      { ord: 1, fragments: [
        { msId: dmA.id, lineId: da1, startCp: 0, endCp: 5 },
        { msId: dmB.id, lineId: db1, startCp: 0, endCp: 5 },
        { msId: dmC.id, lineId: dc1, startCp: 0, endCp: 5 },
      ]},
    ];
    r = await call(base, 'PUT', `/documents/${d3}/groups`, { expectedVersion: d3v.document.version, groups: groupsV1 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const prePublishVersion = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;
    r = await call(base, 'POST', `/documents/${d3}/publish`, { expectedVersion: prePublishVersion });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.editionNo, 1);
    // 发布即定稿：快照版本号 = bump 后的工作版版本号（两侧均显示“版本号”）
    const v1version = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;
    assert.strictEqual(v1version, prePublishVersion + 1);
    assert.strictEqual((await call(base, 'GET', `/documents/${d3}/editions/1`)).json.view.document.version, v1version);

    // 发布后：新增第 2 行（甲「率性之謂道」、乙同文、丙缺文），改乙第 1 行 姓→性，整批重存（组 ID 全部更换）
    await call(base, 'POST', `/manuscripts/${dmA.id}/lines`, { expectedVersion: v1version, content: '率性之謂道' });
    await call(base, 'POST', `/manuscripts/${dmB.id}/lines`, { expectedVersion: v1version + 1, content: '率性之謂道' });
    // 新增抄本丁（不录文）
    await call(base, 'POST', `/documents/${d3}/manuscripts`, { expectedVersion: v1version + 2, name: '丁' });
    r = await call(base, 'PUT', `/lines/${db1}`, {
      expectedVersion: v1version + 3, startCp: 4, endCp: 5, replacement: '性',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    const da2 = d3v.rawByMs.find((x: any) => x.msId === dmA.id).lines[1].lineId;
    const db2 = d3v.rawByMs.find((x: any) => x.msId === dmB.id).lines[1].lineId;
    const groupsV2 = [
      { ord: 1, fragments: [
        { msId: dmA.id, lineId: da1, startCp: 0, endCp: 5 },
        { msId: dmB.id, lineId: db1, startCp: 0, endCp: 5 },
        { msId: dmC.id, lineId: dc1, startCp: 0, endCp: 5 },
      ]},
      { ord: 2, fragments: [
        { msId: dmA.id, lineId: da2, startCp: 0, endCp: 5 },
        { msId: dmB.id, lineId: db2, startCp: 0, endCp: 5 },
        { msId: dmC.id, missing: true },
      ]},
    ];
    r = await call(base, 'PUT', `/documents/${d3}/groups`, { expectedVersion: d3v.document.version, groups: groupsV2 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const v2version = (await call(base, 'GET', `/documents/${d3}`)).json.document.version;

    let diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
    // 两侧底本与版本号
    assert.strictEqual(diff.sides.old.kind, 'edition');
    assert.strictEqual(diff.sides.old.editionNo, 1);
    assert.strictEqual(diff.sides.old.version, v1version, '旧侧版本号应为快照定稿时的版本号');
    assert.strictEqual(diff.sides.old.baseMsName, '底甲');
    assert.strictEqual(diff.sides.new.kind, 'working');
    assert.strictEqual(diff.sides.new.version, v2version);
    assert.strictEqual(diff.baseSame, true);
    // 行文：甲新增行2、乙行1改字 + 新增行2
    const a1Diff = diff.textChanges.find((t: any) => t.msId === dmA.id && t.lineNo === 1);
    assert.ok(!a1Diff, '甲行1未改动，不应出现');
    const a2Diff = diff.textChanges.find((t: any) => t.msId === dmA.id && t.lineNo === 2);
    assert.strictEqual(a2Diff.status, 'added');
    const b1Diff = diff.textChanges.find((t: any) => t.msId === dmB.id && t.lineNo === 1);
    assert.strictEqual(b1Diff.status, 'changed');
    assert.ok(b1Diff.segments.some((s: any) => s.op === 'removed' && s.text === '姓'), '应有删除「姓」');
    assert.ok(b1Diff.segments.some((s: any) => s.op === 'added' && s.text === '性'), '应有新增「性」');
    // 新增抄本丁
    assert.ok(diff.manuscripts.find((m: any) => m.name === '丁' && !m.inOld && m.inNew), '丁应为新增抄本');
    // 组配对：不得凭 ID——两组底本位置 [行1,0,5) 相同且唯一 → 配对；[行2,0,5) 仅新侧 → 新未配对
    assert.strictEqual(diff.groupDiff.counts.paired, 1);
    assert.strictEqual(diff.groupDiff.counts.unpairedOld, 0);
    assert.strictEqual(diff.groupDiff.counts.unpairedNew, 1);
    assert.strictEqual(diff.groupDiff.unpairedNew[0].reason, 'not-matched');
    assert.ok(diff.groupDiff.unpairedNew[0].cells.some((c: any) => c.msId === dmC.id && c.state === 'missing'),
      '未配对新组应显式呈现丙的缺文标记');
    const paired1 = diff.groupDiff.paired[0];
    assert.strictEqual(paired1.status, 'changed');
    assert.strictEqual(paired1.ordChanged, false);
    // 整批重存更换了组 ID，但仍能配对（不凭 ID）
    assert.notStrictEqual(paired1.oldGroupId, paired1.newGroupId);
    const bChange = paired1.cellChanges.find((c: any) => c.msId === dmB.id);
    assert.ok(bChange, '乙本片段应有变化条目');
    assert.strictEqual(bChange.textChanged, true, '姓→性为确定文字改动（两侧均完好）');
    assert.strictEqual(bChange.oldText, '天命之謂姓');
    assert.strictEqual(bChange.newText, '天命之謂性');
    assert.ok(
      !paired1.cellChanges.some((c: any) => c.msId === dmA.id),
      '甲本无变化，不应出现在变化条目里'
    );

    // 对照是只读：再次取工作版版本号不变
    assert.strictEqual((await call(base, 'GET', `/documents/${d3}`)).json.document.version, v2version,
      '对照不得修改工作版');

    // 旧版不存在 → 404，错误信息明确
    r = await call(base, 'GET', `/documents/${d3}/editions/99/diff`);
    await expectFail(r, 404, '不存在');

    // 刷新即反映最新工作版：再做一次改动后重新对照，行文变化应包含新改动
    r = await call(base, 'PUT', `/lines/${da2}`, {
      expectedVersion: v2version, startCp: 0, endCp: 1, replacement: '脩',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
    // 甲第 2 行在旧版整行不存在 → 始终为“新增行”，改字后新增文本应是最新的「脩性之謂道」
    const a2AfterEdit = diff.textChanges.find((t: any) => t.msId === dmA.id && t.lineNo === 2);
    assert.strictEqual(a2AfterEdit.status, 'added');
    assert.ok(a2AfterEdit.newText.includes('脩') && !a2AfterEdit.newText.includes('修'),
      '刷新后新增行内容应反映最新工作版改字');
    // 乙第 2 行同为新增行，内容未受影响
    const b2AfterEdit = diff.textChanges.find((t: any) => t.msId === dmB.id && t.lineNo === 2);
    assert.strictEqual(b2AfterEdit.newText, '率性之謂道');
    // 改字与组2底本片段 [0,5) 相交 → 组2待修复；片段仍在行内：字面文字确定，但须显式标待修复
    let npAfterEdit = diff.groupDiff.unpairedNew.find((g: any) => g.ord === 2);
    assert.ok(npAfterEdit.broken, '相交改动后组2应为待修复并显式标识');
    const baseCellInRange = npAfterEdit.cells.find((c: any) => c.isBase);
    assert.strictEqual(baseCellInRange.broken, true);
    assert.strictEqual(baseCellInRange.outOfBounds, false, '行内片段不算越界');
    assert.strictEqual(baseCellInRange.text, '脩性之謂道', '行内待修复片段的字面文字仍为确定文字');

    // 真正缩短甲第 2 行至 3 字 → 组2底本片段 [0,5) 越界：现存部分不作确定文字
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    r = await call(base, 'PUT', `/lines/${da2}`, {
      expectedVersion: d3v.document.version, startCp: 3, endCp: 5, replacement: '',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
    npAfterEdit = diff.groupDiff.unpairedNew.find((g: any) => g.ord === 2);
    const baseCellOob = npAfterEdit.cells.find((c: any) => c.isBase);
    assert.ok(baseCellOob.broken && baseCellOob.outOfBounds, '缩短越界须显式标识');
    assert.strictEqual(baseCellOob.text, null, '越界片段不得作为确定文字');
    assert.strictEqual(baseCellOob.visibleText, '脩性之', '越界前可见部分仅供参考');
    assert.strictEqual(baseCellOob.oobEnd, 3);

    // 恢复甲第 2 行原文，供后续修复
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    r = await call(base, 'PUT', `/lines/${da2}`, {
      expectedVersion: d3v.document.version, startCp: 3, endCp: 3, replacement: '之謂道',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));

    // ---------- 底本不同：组不配对，旧组与新组分别列出 ----------
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    // 先修复组2，使切底本场景干净
    const g2id = d3v.groups.find((g: any) => g.ord === 2).id;
    r = await call(base, 'PUT', `/documents/${d3}/groups/${g2id}/repair`, {
      expectedVersion: d3v.document.version,
      group: { ord: 2, fragments: [
        { msId: dmA.id, lineId: da2, startCp: 0, endCp: 5 },
        { msId: dmB.id, lineId: db2, startCp: 0, endCp: 5 },
        { msId: dmC.id, missing: true },
      ]},
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    d3v = (await call(base, 'GET', `/documents/${d3}`)).json;
    // 切换底本到丙：两组均无丙的真实片段 → 全部待修复
    r = await call(base, 'PUT', `/documents/${d3}/base`, { expectedVersion: d3v.document.version, msId: dmC.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    diff = (await call(base, 'GET', `/documents/${d3}/editions/1/diff`)).json;
    assert.strictEqual(diff.baseSame, false, '两侧底本不同');
    assert.strictEqual(diff.groupDiff.counts.paired, 0, '底本不同不得配对');
    assert.strictEqual(diff.groupDiff.unpairedOld.length, 1, '旧版 1 组整组列出');
    assert.strictEqual(diff.groupDiff.unpairedNew.length, 2, '工作版 2 组整组列出');
    assert.ok(diff.groupDiff.unpairedNew.every((g: any) => g.reason === 'base-differs'),
      '底本不同原因须显式标注');
    const nbG1 = diff.groupDiff.unpairedNew.find((g: any) => g.ord === 1);
    const nbG2 = diff.groupDiff.unpairedNew.find((g: any) => g.ord === 2);
    assert.strictEqual(nbG1.broken, false, '组1含新底本丙的真实片段，不需待修复');
    assert.strictEqual(nbG2.broken, true, '组2新底本丙仅标缺文，须带待修复标识');
    assert.ok(diff.groupDiff.unpairedOld[0].cells.some((c: any) => c.isBase && c.text === '天命之謂性'),
      '旧组底本文字仍应确定呈现');

    console.log('✅ 全部集成测试通过');
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
