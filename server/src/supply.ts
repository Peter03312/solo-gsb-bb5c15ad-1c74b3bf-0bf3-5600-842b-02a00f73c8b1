import {
  CellView,
  CollationView,
  SupplyCandidate,
  SupplyGroupDTO,
  SupplyPreview,
  SupplyReason,
} from './types';
import { charLen, rangesOverlap, sliceCp } from './util';

/** 目标抄本上的一个占用区间（来自任何已存在的真实片段，含待修复组）。 */
interface Occupied {
  lineId: number;
  startCp: number;
  endCp: number;
}

interface FreeHit {
  groupId: number;
  ord: number;
  baseText: string;
  lineId: number;
  lineNo: number;
  startCp: number;
  endCp: number;
}

/**
 * 构建补配候选预览（纯读模型计算，不落库）：
 *
 * 仅考虑“完好对应组”（group.broken=false，且其底本片段完好可截取文字）中
 * 目标抄本既无片段也未标缺文的组；待修复组不参与补配。
 *
 * 候选条件：在目标抄本的某一单行内，存在与底本片段文字按 Unicode 码点
 * 完全相同的完整连续字句；且该区间不与该抄本任何现有片段区间重叠
 * （端点相接允许）。码点区间以 [startCp, endCp) 表示。
 *
 * 组判定：
 *  - 无任何空闲命中                         → no-candidate；
 *  - 空闲命中 ≥ 2 处                        → multiple-candidates；
 *  - 唯一空闲命中但与其他组候选区间重叠      → candidate-conflict；
 *  - 唯一空闲命中且无组间重叠               → adoptable=true（可直接采纳）。
 */
export function buildSupplyPreview(view: CollationView, targetMsId: number): SupplyPreview {
  const targetMs = view.manuscripts.find((m) => m.id === targetMsId);
  const baseMs = view.manuscripts.find((m) => m.id === view.document.baseMsId) ?? null;
  const targetRaw = view.rawByMs.find((r) => r.msId === targetMsId);
  const targetLines = targetRaw?.lines ?? [];

  // 现有片段占用区间：全部组在目标抄本上的真实片段（含待修复组；缺文无区间）。
  // rawByMs.covered 已是“裁剪到行内、非空”的有效区间，直接采用。
  const occupied: Occupied[] = [];
  for (const l of targetLines) {
    for (const c of l.covered) {
      occupied.push({ lineId: l.lineId, startCp: c.startCp, endCp: c.endCp });
    }
  }
  const isFree = (lineId: number, s: number, e: number): boolean =>
    !occupied.some((o) => o.lineId === lineId && rangesOverlap(s, e, o.startCp, o.endCp));

  const freeHits: FreeHit[] = [];

  const groupDtos: SupplyGroupDTO[] = [];

  for (const g of view.groups) {
    if (g.broken) continue; // 待修复组不参与补配
    const targetCell: CellView | undefined = g.cells.find((c) => c.msId === targetMsId);
    // 目标抄本已有片段或已显式标缺文 → 该组不参与
    if (!targetCell || targetCell.missing || targetCell.startCp != null || targetCell.endCp != null) {
      continue;
    }
    // 底本片段文字：完好组的底本片段应可确定截取
    const baseText = g.baseText ?? '';
    if (baseText === '') continue;

    const hits: SupplyCandidate[] = [];
    let blockedByExisting = 0;
    for (const line of targetLines) {
      const len = charLen(line.content);
      const needleLen = charLen(baseText);
      if (needleLen === 0 || needleLen > len) continue;
      for (let s = 0; s + needleLen <= len; s++) {
        const e = s + needleLen;
        if (sliceCp(line.content, s, e) !== baseText) continue;
        if (!isFree(line.lineId, s, e)) {
          blockedByExisting++;
          continue;
        }
        hits.push({
          lineId: line.lineId,
          lineNo: line.lineNo,
          startCp: s,
          endCp: e,
          text: baseText,
          conflictsWith: [],
        });
        freeHits.push({ groupId: g.id, ord: g.ord, baseText, lineId: line.lineId, lineNo: line.lineNo, startCp: s, endCp: e });
      }
    }

    let reason: SupplyReason | null = null;
    let reasonText: string | null = null;
    if (hits.length === 0) {
      reason = 'no-candidate';
      reasonText =
        blockedByExisting > 0
          ? `底本文字「${baseText}」在该抄本无空闲单行相同文字（${blockedByExisting} 处出现均被现有片段占用）`
          : `底本文字「${baseText}」在该抄本任一行中均无完全相同的文字`;
    } else if (hits.length > 1) {
      reason = 'multiple-candidates';
      reasonText = `底本文字「${baseText}」在该抄本有 ${hits.length} 处空闲相同文字，需人工选择其一`;
    }

    groupDtos.push({
      groupId: g.id,
      ord: g.ord,
      baseText,
      adoptable: false, // 待组间冲突计算后再定
      reason,
      reasonText,
      candidates: hits,
      blockedByExisting,
    });
  }

  // 组间候选冲突：同一行内区间相交即冲突（端点相接不算）。
  // 无候选 / 多候选的组已有人工原因，但其候选仍参与他人的冲突标记；
  // adoptable 仅在“唯一候选”的组上产生。
  for (let i = 0; i < freeHits.length; i++) {
    for (let j = i + 1; j < freeHits.length; j++) {
      const a = freeHits[i];
      const b = freeHits[j];
      if (a.groupId === b.groupId) continue;
      if (a.lineId !== b.lineId) continue;
      if (!rangesOverlap(a.startCp, a.endCp, b.startCp, b.endCp)) continue;
      const da = groupDtos.find((x) => x.groupId === a.groupId)!;
      const db = groupDtos.find((x) => x.groupId === b.groupId)!;
      da.candidates
        .find((c) => c.lineId === a.lineId && c.startCp === a.startCp && c.endCp === a.endCp)!
        .conflictsWith.push({ groupId: b.groupId, ord: b.ord, lineId: b.lineId, startCp: b.startCp, endCp: b.endCp });
      db.candidates
        .find((c) => c.lineId === b.lineId && c.startCp === b.startCp && c.endCp === b.endCp)!
        .conflictsWith.push({ groupId: a.groupId, ord: a.ord, lineId: a.lineId, startCp: a.startCp, endCp: a.endCp });
    }
  }

  let adoptableCount = 0;
  for (const dto of groupDtos) {
    if (dto.candidates.length === 1 && dto.candidates[0].conflictsWith.length === 0) {
      dto.adoptable = true;
      dto.reason = null;
      dto.reasonText = null;
      adoptableCount++;
    } else if (dto.candidates.length === 1 && dto.candidates[0].conflictsWith.length > 0) {
      dto.reason = 'candidate-conflict';
      const other = dto.candidates[0].conflictsWith.map((c) => `第 ${c.ord} 组`).join('、');
      dto.reasonText = `唯一候选与其他组候选区间重叠（${other}），需人工处理`;
    }
  }

  groupDtos.sort((a, b) => a.ord - b.ord);

  return {
    documentId: view.document.id,
    title: view.document.title,
    version: view.document.version,
    targetMsId,
    targetMsName: targetMs?.name ?? `#${targetMsId}`,
    baseMsId: view.document.baseMsId,
    baseMsName: baseMs?.name ?? null,
    generatedAt: new Date().toISOString(),
    eligibleGroupCount: groupDtos.length,
    adoptableCount,
    groups: groupDtos,
  };
}
