import { Router, Request, Response, NextFunction } from 'express';
import { withTx, query } from './db';
import { buildView } from './collation';
import { buildEditionDiff } from './diff';
import { buildSupplyPreview } from './supply';
import { validateGroups } from './validate';
import { charLen, HttpError, isInt, sliceCp } from './util';
import {
  bumpVersion,
  checkVersion,
  getDoc,
  loadLines,
  loadMss,
  lockDoc,
} from './repo';
import { FragmentDTO, GroupDTO } from './types';

export const router = Router();

/** 统一异步错误处理 */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// ---------- 文献 ----------

router.get(
  '/documents',
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT d.id, d.title, d.version, d.published_ver,
              d.base_ms_id,
              (SELECT count(*) FROM manuscripts m WHERE m.doc_id=d.id)::int AS ms_count,
              (SELECT count(*) FROM grp g WHERE g.doc_id=d.id AND g.broken)::int AS broken_count
       FROM documents d ORDER BY d.id DESC`
    );
    res.json({ documents: rows });
  })
);

router.post(
  '/documents',
  wrap(async (req, res) => {
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : null;
    if (!title) throw new HttpError(400, '请填写文献标题');
    const msNames: string[] = Array.isArray(req.body.manuscripts)
      ? req.body.manuscripts.map((x: unknown) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
      : [];
    if (msNames.length < 2) throw new HttpError(400, '至少需要录入两份抄本');
    if (new Set(msNames).size !== msNames.length) throw new HttpError(400, '抄本名称不能重复');

    const result = await withTx(async (c) => {
      const { rows: d } = await c.query(
        'INSERT INTO documents (title) VALUES ($1) RETURNING id, version',
        [title]
      );
      const docId = d[0].id;
      for (let i = 0; i < msNames.length; i++) {
        await c.query(
          'INSERT INTO manuscripts (doc_id, name, position) VALUES ($1,$2,$3)',
          [docId, msNames[i], i + 1]
        );
      }
      // 默认以第一份抄本为底本
      const { rows: m } = await c.query(
        'SELECT id FROM manuscripts WHERE doc_id=$1 ORDER BY position, id LIMIT 1',
        [docId]
      );
      await c.query('UPDATE documents SET base_ms_id=$1 WHERE id=$2', [m[0].id, docId]);
      return docId;
    });
    res.status(201).json({ id: result });
  })
);

router.get(
  '/documents/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const view = await withTx(async (c) => buildView(c, await getDoc(c, id)));
    res.json(view);
  })
);

// ---------- 抄本 / 底本 ----------

router.post(
  '/documents/:id/manuscripts',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) throw new HttpError(400, '请填写抄本名称');
    await withTx(async (c) => {
      const doc = await lockDoc(c, id);
      checkVersion(doc, req.body?.expectedVersion);
      const mss = await loadMss(c, id);
      if (mss.some((m) => m.name === name)) throw new HttpError(400, '抄本名称不能重复');
      await c.query(
        'INSERT INTO manuscripts (doc_id, name, position) VALUES ($1,$2,$3)',
        [id, name, mss.length + 1]
      );
      await bumpVersion(c, id);
    });
    res.status(201).json({ ok: true });
  })
);

/** 选定底本；切换后不含新底本真实片段的组标为待修复。 */
router.put(
  '/documents/:id/base',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const msId = req.body?.msId;
    if (!isInt(msId)) throw new HttpError(400, 'msId 必须是整数');
    await withTx(async (c) => {
      const doc = await lockDoc(c, id);
      checkVersion(doc, req.body?.expectedVersion);
      const mss = await loadMss(c, id);
      if (!mss.some((m) => m.id === msId)) throw new HttpError(400, '该抄本不属于本文献');
      await c.query('UPDATE documents SET base_ms_id=$1 WHERE id=$2', [msId, id]);
      // 没有新底本真实片段的组 → 待修复
      await c.query(
        `UPDATE grp SET broken=TRUE WHERE doc_id=$1 AND id NOT IN (
           SELECT f.group_id FROM fragments f
           WHERE f.doc_id=$1 AND f.ms_id=$2 AND f.missing=FALSE AND f.line_id IS NOT NULL
         )`,
        [id, msId]
      );
      await bumpVersion(c, id);
    });
    res.json({ ok: true });
  })
);

// ---------- 逐行文字 ----------

router.post(
  '/manuscripts/:msId/lines',
  wrap(async (req, res) => {
    const msId = Number(req.params.msId);
    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    if (content == null) throw new HttpError(400, '请提供 content（可为空串）');
    await withTx(async (c) => {
      const { rows: ms } = await c.query(
        'SELECT id, doc_id FROM manuscripts WHERE id=$1 FOR UPDATE',
        [msId]
      );
      if (ms.length === 0) throw new HttpError(404, `抄本 #${msId} 不存在`);
      const doc = await lockDoc(c, ms[0].doc_id);
      checkVersion(doc, req.body?.expectedVersion);
      const { rows: max } = await c.query(
        'SELECT COALESCE(MAX(line_no),0)::int AS n FROM lines WHERE ms_id=$1',
        [msId]
      );
      await c.query(
        'INSERT INTO lines (ms_id, line_no, content) VALUES ($1,$2,$3)',
        [msId, max[0].n + 1, content]
      );
      await bumpVersion(c, doc.id);
    });
    res.status(201).json({ ok: true });
  })
);

/**
 * 修改某一行原文（按码点替换 [startCp,endCp) 为 replacement）。
 * 仅使受影响对应组待修复：
 *  - 片段区间与改动区间相交 → 立即待修复（偏移不动，留待研究者修复）；
 *  - 不相交但位于改动点之后 → 整体平移；
 *  - 平移后若越界（缩行）→ 待修复；其余组完好。
 */
router.put(
  '/lines/:lineId',
  wrap(async (req, res) => {
    const lineId = Number(req.params.lineId);
    const { startCp, endCp, replacement } = req.body ?? {};
    if (!isInt(startCp) || !isInt(endCp) || typeof replacement !== 'string' || startCp < 0 || endCp < startCp) {
      throw new HttpError(400, '需要 startCp/endCp（非负整数，起≤止）与 replacement（字符串）');
    }
    await withTx(async (c) => {
      const { rows: lr } = await c.query(
        'SELECT id, ms_id, line_no, content FROM lines WHERE id=$1 FOR UPDATE',
        [lineId]
      );
      if (lr.length === 0) throw new HttpError(404, `行 #${lineId} 不存在`);
      const line = lr[0];
      const doc = await lockDoc(c, (await c.query<{ doc_id: number }>('SELECT doc_id FROM manuscripts WHERE id=$1', [line.ms_id])).rows[0].doc_id);
      checkVersion(doc, req.body?.expectedVersion);

      const oldLen = charLen(line.content);
      if (startCp > oldLen || endCp > oldLen) {
        throw new HttpError(400, `替换区间越界：该行共 ${oldLen} 字`, {
          lineNo: line.line_no,
          lineLength: oldLen,
        });
      }
      const newContent = sliceCp(line.content, 0, startCp) + replacement + sliceCp(line.content, endCp, oldLen);
      const delta = charLen(replacement) - (endCp - startCp);

      const { rows: frags } = await c.query<{
        id: number;
        group_id: number;
        start_cp: number;
        end_cp: number;
      }>(
        `SELECT f.id, f.group_id, f.start_cp, f.end_cp
         FROM fragments f WHERE f.line_id=$1 AND f.missing=FALSE
         ORDER BY f.start_cp FOR UPDATE OF f`,
        [lineId]
      );

      const touchedGroups = new Set<number>();
      for (const f of frags) {
        const intersects = f.start_cp < endCp && startCp < f.end_cp;
        if (intersects) {
          touchedGroups.add(f.group_id); // 偏移保持原样，等修复
        } else {
          let ns = f.start_cp;
          let ne = f.end_cp;
          if (f.start_cp >= endCp) {
            ns += delta;
            ne += delta;
          }
          // 平移后越界同样待修复
          const newLen = charLen(newContent);
          if (ns < 0 || ne <= ns || ns >= newLen || ne > newLen) {
            touchedGroups.add(f.group_id);
          } else {
            await c.query('UPDATE fragments SET start_cp=$1, end_cp=$2 WHERE id=$3', [ns, ne, f.id]);
          }
        }
      }

      if (touchedGroups.size > 0) {
        await c.query(
          'UPDATE grp SET broken=TRUE WHERE id = ANY($1::bigint[])',
          [[...touchedGroups]]
        );
      }
      await c.query('UPDATE lines SET content=$1 WHERE id=$2', [newContent, lineId]);
      await bumpVersion(c, doc.id);
    });
    res.json({ ok: true });
  })
);

// ---------- 对应组 ----------

/** 整批保存（替换）某文献全部对应组；任一校验失败整体拒绝。 */
router.put(
  '/documents/:id/groups',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(async (c) => {
      const doc = await lockDoc(c, id);
      checkVersion(doc, req.body?.expectedVersion);
      const mss = await loadMss(c, id);
      const lines = await loadLines(c, mss.map((m) => m.id));
      const groups = validateGroups(req.body?.groups, {
        baseMsId: doc.base_ms_id,
        manuscripts: mss,
        lines,
      });

      // ord 连续性
      const ords = groups.map((g) => g.ord).sort((a, b) => a - b);
      if (ords.some((o, i) => o !== i + 1)) {
        throw new HttpError(400, '组序号 ord 必须从 1 开始连续编号（底本顺序），不能有缺号', {
          ords,
        });
      }

      await c.query('DELETE FROM grp WHERE doc_id=$1', [id]);
      for (const g of groups) {
        const { rows: gr } = await c.query(
          'INSERT INTO grp (doc_id, ord, broken) VALUES ($1,$2,FALSE) RETURNING id',
          [id, g.ord]
        );
        const gid = gr[0].id;
        for (const f of g.fragments as FragmentDTO[]) {
          await c.query(
            `INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [gid, id, f.msId, f.missing ? null : f.lineId, f.missing ? null : f.startCp, f.missing ? null : f.endCp, !!f.missing]
          );
        }
      }
      await bumpVersion(c, id);
    });
    res.json({ ok: true });
  })
);

/** 修复单个对应组（整组重录）；与其他组重叠/越界同样精确定位拒绝。 */
router.put(
  '/documents/:id/groups/:groupId/repair',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const groupId = Number(req.params.groupId);
    await withTx(async (c) => {
      const doc = await lockDoc(c, id);
      checkVersion(doc, req.body?.expectedVersion);
      const mss = await loadMss(c, id);
      const lines = await loadLines(c, mss.map((m) => m.id));

      const { rows: grow } = await c.query<{ id: number; ord: number }>(
        'SELECT id, ord FROM grp WHERE id=$1 AND doc_id=$2 FOR UPDATE',
        [groupId, id]
      );
      if (grow.length === 0) throw new HttpError(404, `对应组 #${groupId} 不存在`);

      const candidate = req.body?.group as GroupDTO | undefined;
      if (!candidate || typeof candidate !== 'object') throw new HttpError(400, '缺少 group');

      // 以“其余组 + 本组”拼成完整集合做全量校验（错误位置一致、规则不重复）
      const { rows: others } = await c.query<{ id: number; ord: number }>(
        'SELECT id, ord FROM grp WHERE doc_id=$1 AND id<>$2 ORDER BY ord',
        [id, groupId]
      );
      const { rows: ofrags } = await c.query<{
        id: number; group_id: number; ms_id: number; line_id: number | null;
        start_cp: number | null; end_cp: number | null; missing: boolean;
      }>(
        'SELECT id, group_id, ms_id, line_id, start_cp, end_cp, missing FROM fragments WHERE group_id = ANY($1::bigint[])',
        [others.map((o) => o.id)]
      );

      const synthetic: GroupDTO[] = others
        .sort((a, b) => a.ord - b.ord)
        .map((o) => ({
          id: o.id,
          ord: o.ord,
          fragments: ofrags
            .filter((f) => f.group_id === o.id)
            .map((f) => ({
              msId: f.ms_id,
              missing: f.missing,
              lineId: f.line_id,
              startCp: f.start_cp,
              endCp: f.end_cp,
            })),
        }));
      synthetic.push({ ...candidate, ord: grow[0].ord });
      synthetic.sort((a, b) => a.ord - b.ord).forEach((g, i) => (g.ord = i + 1));

      validateGroups(synthetic, { baseMsId: doc.base_ms_id, manuscripts: mss, lines });

      await c.query('DELETE FROM fragments WHERE group_id=$1', [groupId]);
      for (const f of candidate.fragments) {
        await c.query(
          `INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [groupId, id, f.msId, f.missing ? null : f.lineId, f.missing ? null : f.startCp, f.missing ? null : f.endCp, !!f.missing]
        );
      }
      await c.query('UPDATE grp SET broken=FALSE WHERE id=$1', [groupId]);
      await bumpVersion(c, id);
    });
    res.json({ ok: true });
  })
);

/** 删除一个对应组。 */
router.delete(
  '/documents/:id/groups/:groupId',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const groupId = Number(req.params.groupId);
    await withTx(async (c) => {
      const doc = await lockDoc(c, id);
      checkVersion(doc, req.body?.expectedVersion);
      const { rows } = await c.query('SELECT 1 FROM grp WHERE id=$1 AND doc_id=$2', [groupId, id]);
      if (rows.length === 0) throw new HttpError(404, `对应组 #${groupId} 不存在`);
      await c.query('DELETE FROM grp WHERE id=$1', [groupId]);
      await bumpVersion(c, id);
    });
    res.json({ ok: true });
  })
);

// ---------- 自动补配（按完好对应组底本文字，在目标抄本行文中补配片段） ----------

/**
 * 补配候选预览（只读，不推进版本）：
 * 仅考虑完好对应组中目标抄本尚无片段且未标缺文的组；
 * 候选为目标抄本某一单行内与底本文字按 Unicode 码点完全相同、
 * 且不占用任何现有片段区间的文字。返回行号与 [startCp,endCp) 码点区间，
 * 以及无候选 / 多候选 / 组间候选区间重叠的原因。
 */
router.get(
  '/documents/:id/supply-preview',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const msId = Number(req.query.msId);
    if (!isInt(msId) || msId < 1) throw new HttpError(400, '需要 msId（正整数）指定目标抄本');
    const result = await withTx(async (c) => {
      const doc = await getDoc(c, id);
      const mss = await loadMss(c, id);
      if (!mss.some((m) => m.id === msId)) throw new HttpError(400, '该抄本不属于本文献');
      if (doc.base_ms_id === msId) throw new HttpError(400, '目标抄本不能是底本（底本文字即归组基准）');
      const view = await buildView(c, doc);
      return buildSupplyPreview(view, msId);
    });
    res.json(result);
  })
);

/**
 * 提交补配选择（整批，要么全部写入要么全部拒绝）。
 * body: { expectedVersion, msId, selections: [{ groupId, lineId, startCp, endCp }] }
 *
 * 在当前工作版（加行锁）下逐项重新核对：
 *  1. expectedVersion 必须等于当前版本，否则 409（不推进版本）；
 *  2. 组仍存在、仍完好、仍参与补配（目标抄本尚无片段且未标缺文）；
 *  3. 底本文字与预览时一致；行存在且属于目标抄本；区间合法不越界；
 *  4. 该区间文字与底本文字逐码点完全相同，且不与任何现有片段区间重叠；
 *  5. 所选候选彼此之间不重叠。
 * 任一候选失效 → 409 拒绝整批、不写入、不推进版本；
 * 全部通过后再以“既有全部组 + 本组新增片段”跑一遍完整归组校验，
 * 通过才一次性插入并只推进一次版本。未选组与已有片段原样保留。
 */
router.post(
  '/documents/:id/supply',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await withTx(async (c) => {
      const doc = await lockDoc(c, id);
      checkVersion(doc, req.body?.expectedVersion); // 版本过期 → 409
      const msId = req.body?.msId;
      if (!isInt(msId)) throw new HttpError(400, '需要 msId（整数）指定目标抄本');
      const rawSelections = req.body?.selections;
      if (!Array.isArray(rawSelections) || rawSelections.length === 0) {
        throw new HttpError(400, 'selections 必须为非空数组');
      }

      const mss = await loadMss(c, id);
      if (!mss.some((m) => m.id === msId)) throw new HttpError(400, '该抄本不属于本文献');
      if (doc.base_ms_id === msId) throw new HttpError(400, '目标抄本不能是底本');

      // 形状预检（请求格式问题 → 400）
      interface Sel {
        groupId: number;
        lineId: number;
        startCp: number;
        endCp: number;
      }
      const selections: Sel[] = [];
      for (const s of rawSelections as unknown[]) {
        const o = s as { groupId?: unknown; lineId?: unknown; startCp?: unknown; endCp?: unknown } | null;
        if (
          !o || typeof o !== 'object' ||
          !isInt(o.groupId) || !isInt(o.lineId) || !isInt(o.startCp) || !isInt(o.endCp)
        ) {
          throw new HttpError(400, '每个选择须含整数 groupId/lineId/startCp/endCp', { item: o });
        }
        if (o.startCp < 0 || o.endCp <= o.startCp) {
          throw new HttpError(400, '候选区间非法（需 0 ≤ startCp < endCp）', { item: o });
        }
        selections.push({ groupId: o.groupId, lineId: o.lineId, startCp: o.startCp, endCp: o.endCp });
      }
      const selGroupIds = new Set(selections.map((s) => s.groupId));
      if (selGroupIds.size !== selections.length) {
        throw new HttpError(400, '每个对应组至多选择一个候选（存在重复组）');
      }

      // 取当前工作版全部数据（行锁保护下）
      const { rows: grpRows } = await c.query<{ id: number; ord: number; broken: boolean }>(
        'SELECT id, ord, broken FROM grp WHERE doc_id=$1 ORDER BY ord FOR UPDATE',
        [id]
      );
      const { rows: fragRows } = await c.query<{
        id: number; group_id: number; ms_id: number; line_id: number | null;
        start_cp: number | null; end_cp: number | null; missing: boolean;
      }>(
        'SELECT id, group_id, ms_id, line_id, start_cp, end_cp, missing FROM fragments WHERE doc_id=$1 FOR UPDATE',
        [id]
      );
      const lines = await loadLines(c, mss.map((m) => m.id));
      const lineById = new Map(lines.map((l) => [l.id, l]));
      const msById = new Map(mss.map((m) => [m.id, m]));

      const stale = (message: string, extra?: Record<string, unknown>) =>
        new HttpError(409, message, { code: 'CANDIDATE_STALE', ...extra });

      // 当前各组的底本文字（须为完好底本片段）与目标抄本占用区间
      const baseTextOf = (groupId: number): string | null => {
        const fs = fragRows.filter((f) => f.group_id === groupId);
        const bf = fs.find((f) => f.ms_id === doc.base_ms_id && !f.missing);
        if (!bf || bf.line_id == null || bf.start_cp == null || bf.end_cp == null) return null;
        const ln = lineById.get(bf.line_id);
        if (!ln || ln.ms_id !== doc.base_ms_id) return null;
        const len = charLen(ln.content);
        if (bf.start_cp < 0 || bf.end_cp <= bf.start_cp || bf.start_cp >= len || bf.end_cp > len) return null;
        return sliceCp(ln.content, bf.start_cp, bf.end_cp);
      };

      // 目标抄本现有真实片段占用区间（任何组，含待修复组；端点相接允许）
      const occupied = fragRows
        .filter((f) => f.ms_id === msId && !f.missing && f.line_id != null && f.start_cp != null && f.end_cp != null)
        .map((f) => ({ lineId: f.line_id as number, s: f.start_cp as number, e: f.end_cp as number }));

      // 逐项重新核对
      const accepted = new Map<number, Sel>();
      for (const s of selections) {
        const g = grpRows.find((x) => x.id === s.groupId);
        if (!g) throw stale(`第 ${s.groupId} 组已不存在，候选失效，请刷新预览`, { groupId: s.groupId });
        if (g.broken) throw stale(`第 ${g.ord} 组为待修复组，不参与补配`, { groupOrd: g.ord });

        const existCell = fragRows.find((f) => f.group_id === s.groupId && f.ms_id === msId);
        if (existCell) {
          throw stale(
            `第 ${g.ord} 组在「${msById.get(msId)!.name}」上已有片段或已标缺文，候选失效`,
            { groupOrd: g.ord }
          );
        }

        const baseText = baseTextOf(s.groupId);
        if (baseText == null) {
          throw stale(`第 ${g.ord} 组底本片段已失效，候选失效，请刷新预览`, { groupOrd: g.ord });
        }

        const ln = lineById.get(s.lineId);
        if (!ln || ln.ms_id !== msId) {
          throw stale(`第 ${g.ord} 组候选引用的行不属于「${msById.get(msId)!.name}」，候选失效`, { groupOrd: g.ord });
        }
        const len = charLen(ln.content);
        if (s.startCp < 0 || s.endCp <= s.startCp || s.startCp >= len || s.endCp > len) {
          throw stale(
            `第 ${g.ord} 组候选区间越界：第 ${ln.line_no} 行共 ${len} 字，区间 [${s.startCp}, ${s.endCp})`,
            { groupOrd: g.ord, lineNo: ln.line_no }
          );
        }
        const text = sliceCp(ln.content, s.startCp, s.endCp);
        if (text !== baseText) {
          throw stale(
            `第 ${g.ord} 组候选文字「${text}」与当前底本文字「${baseText}」不再完全相同，候选失效`,
            { groupOrd: g.ord }
          );
        }
        if (occupied.some((o) => o.lineId === s.lineId && o.s < s.endCp && s.startCp < o.e)) {
          throw stale(
            `第 ${g.ord} 组候选区间（第 ${ln.line_no} 行 [${s.startCp}, ${s.endCp})）与现有片段重叠，候选失效`,
            { groupOrd: g.ord, lineNo: ln.line_no }
          );
        }
        accepted.set(s.groupId, s);
      }

      // 所选候选彼此之间不得重叠（同一行内区间相交）
      const arr = [...accepted.values()];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i];
          const b = arr[j];
          if (a.lineId === b.lineId && a.startCp < b.endCp && b.startCp < a.endCp) {
            throw stale('所选候选之间存在区间重叠，不能整批采纳，请人工取舍', {
              groupIds: [a.groupId, b.groupId],
            });
          }
        }
      }

      // 以“既有全部组（含新增片段）”跑完整归组规则校验，复用同一套定位式校验
      const synthetic: GroupDTO[] = grpRows.map((g) => ({
        id: g.id,
        ord: g.ord,
        fragments: fragRows
          .filter((f) => f.group_id === g.id)
          .map((f): FragmentDTO => ({
            msId: f.ms_id,
            missing: f.missing,
            lineId: f.line_id,
            startCp: f.start_cp,
            endCp: f.end_cp,
          })),
      }));
      for (const s of arr) {
        const dto = synthetic.find((g) => g.id === s.groupId)!;
        dto.fragments.push({ msId, missing: false, lineId: s.lineId, startCp: s.startCp, endCp: s.endCp });
      }
      try {
        validateGroups(synthetic, { baseMsId: doc.base_ms_id, manuscripts: mss, lines });
      } catch (e) {
        // 归组规则（重叠/越界等）不再成立 → 候选失效，409 拒绝整批
        if (e instanceof HttpError) {
          throw new HttpError(409, `候选已失效：${e.message}`, { code: 'CANDIDATE_STALE', issues: e.details });
        }
        throw e;
      }

      // 全部通过 → 一次性写入
      for (const s of arr) {
        await c.query(
          `INSERT INTO fragments (group_id, doc_id, ms_id, line_id, start_cp, end_cp, missing)
           VALUES ($1,$2,$3,$4,$5,$6,FALSE)`,
          [s.groupId, id, msId, s.lineId, s.startCp, s.endCp]
        );
      }
      await bumpVersion(c, id); // 整批只推进一次版本
      return { adopted: arr.length, groupIds: arr.map((s) => s.groupId) };
    });
    res.status(201).json({ ok: true, ...result });
  })
);

// ---------- 发布 ----------

router.post(
  '/documents/:id/publish',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await withTx(async (c) => {
      const doc = await lockDoc(c, id);
      checkVersion(doc, req.body?.expectedVersion);
      const mss = await loadMss(c, id);
      if (mss.length < 2) throw new HttpError(400, '至少需要两份抄本才能发布校勘版');
      if (doc.base_ms_id == null) throw new HttpError(400, '尚未选定底本，不能发布');
      const { rows: broken } = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM grp WHERE doc_id=$1 AND broken=TRUE',
        [id]
      );
      if (broken[0].n > 0) {
        throw new HttpError(
          409,
          `尚有 ${broken[0].n} 个对应组待修复，修复前不得发布新校勘版`,
          { brokenGroups: broken[0].n }
        );
      }
      const { rows: gc } = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM grp WHERE doc_id=$1',
        [id]
      );
      if (gc[0].n === 0) throw new HttpError(400, '还没有任何对应组，不能发布');

      const editionNo = doc.published_ver + 1;
      await c.query('UPDATE documents SET published_ver=$1 WHERE id=$2', [editionNo, id]);
      // 快照固化“发布定稿”状态：先落版本号（乐观锁 +1），再构建读模型，
      // 使快照 document.version 即该已发布版对应的版本号
      await bumpVersion(c, id);
      const published = await getDoc(c, id);
      const view = await buildView(c, published);
      await c.query(
        'INSERT INTO editions (doc_id, edition_no, snapshot) VALUES ($1,$2,$3)',
        [id, editionNo, JSON.stringify(view)]
      );
      return editionNo;
    });
    res.status(201).json({ editionNo: result });
  })
);

router.get(
  '/documents/:id/editions',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      'SELECT id, edition_no, created_at FROM editions WHERE doc_id=$1 ORDER BY edition_no DESC',
      [id]
    );
    res.json({ editions: rows });
  })
);

router.get(
  '/documents/:id/editions/:no',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const no = Number(req.params.no);
    const { rows } = await query(
      'SELECT edition_no, snapshot, created_at FROM editions WHERE doc_id=$1 AND edition_no=$2',
      [id, no]
    );
    if (rows.length === 0) throw new HttpError(404, `校勘版 #${no} 不存在（旧版永久保留可读）`);
    res.json({ editionNo: rows[0].edition_no, createdAt: rows[0].created_at, view: rows[0].snapshot });
  })
);

/**
 * 版本对照：任一已发布校勘版（旧，不可变快照）vs 当前工作版（新，实时读模型）。
 * 只读：不修改工作版，也不修改任何快照；刷新后重新取即反映最新工作版。
 * 旧版不存在 → 404（错误信息明确指出该版不存在）。
 */
router.get(
  '/documents/:id/editions/:no/diff',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const no = Number(req.params.no);
    if (!isInt(no) || no < 1) throw new HttpError(400, '校勘版编号必须是正整数');
    const result = await withTx(async (c) => {
      const doc = await getDoc(c, id);
      const { rows } = await c.query<{ snapshot: unknown; created_at: Date }>(
        'SELECT snapshot, created_at FROM editions WHERE doc_id=$1 AND edition_no=$2',
        [id, no]
      );
      if (rows.length === 0) {
        throw new HttpError(
          404,
          doc.published_ver === 0
            ? `校勘版 #${no} 不存在：本文献尚未发布过任何校勘版`
            : `校勘版 #${no} 不存在：当前仅发布至第 ${doc.published_ver} 版`,
          { requestedEdition: no, latestEdition: doc.published_ver }
        );
      }
      const oldView = rows[0].snapshot as import('./types').CollationView;
      const newView = await buildView(c, doc);
      return buildEditionDiff(oldView, newView, rows[0].created_at.toISOString());
    });
    res.json(result);
  })
);
