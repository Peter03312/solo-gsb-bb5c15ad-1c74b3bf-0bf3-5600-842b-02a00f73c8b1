// 数据库行类型
export interface DocumentRow {
  id: number;
  title: string;
  base_ms_id: number | null;
  version: number;
  published_ver: number;
}

export interface ManuscriptRow {
  id: number;
  doc_id: number;
  name: string;
  position: number;
}

export interface LineRow {
  id: number;
  ms_id: number;
  line_no: number;
  content: string;
}

export interface GroupRow {
  id: number;
  doc_id: number;
  ord: number;
  broken: boolean;
}

export interface FragmentRow {
  id: number;
  group_id: number;
  doc_id: number;
  ms_id: number;
  line_id: number | null;
  start_cp: number | null;
  end_cp: number | null;
  missing: boolean;
}

export interface EditionRow {
  id: number;
  doc_id: number;
  edition_no: number;
  snapshot: CollationView;
  created_at: string;
}

// ---- 对外（API / 前端）类型 ----

export interface FragmentDTO {
  msId: number;
  missing: boolean;
  lineId?: number | null;
  startCp?: number | null;
  endCp?: number | null;
}

export interface GroupDTO {
  id?: number;
  ord: number;
  fragments: FragmentDTO[];
}

/** 组在某抄本上的呈现片段（读模型，运行时派生）。 */
export interface CellView {
  msId: number;
  missing: boolean;          // 显式缺文
  broken: boolean;           // 原文改动后越界 / 底本已变 → 待修复
  lineNo?: number;
  startCp?: number;
  endCp?: number;
  text?: string;             // 当前原文截取；越界时为越界前可见部分
  oobEnd?: number;           // endCp 超过当前行长时的实际行长
}

export interface GroupView {
  id: number;
  ord: number;
  broken: boolean;
  baseText: string;          // 底本片段文字（底本缺失则为空串）
  inverted: boolean;         // 相对底本顺序的倒置
  cells: CellView[];
  variant: boolean;          // 存在异文
  hasMissing: boolean;       // 存在显式缺文
}

export interface RawLineView {
  lineId: number;
  lineNo: number;
  content: string;
  // 已被有效片段覆盖的码点区间（用于下划线标识），互不重叠
  covered: Array<{ startCp: number; endCp: number; groupId: number; broken: boolean }>;
}

export interface CollationView {
  document: {
    id: number;
    title: string;
    version: number;
    baseMsId: number | null;
    publishedVer: number;
  };
  manuscripts: Array<{ id: number; name: string; position: number; isBase: boolean }>;
  groups: GroupView[];
  /** 各抄本原始行序视图（含未归组文字）。 */
  rawByMs: Array<{ msId: number; lines: RawLineView[] }>;
  stats: {
    manuscriptCount: number;
    lineCount: number;
    groupCount: number;
    brokenCount: number;
  };
}

// ---- 版本对照（任一已发布校勘版 vs 当前工作版）----

export interface DiffSideInfo {
  kind: 'edition' | 'working';
  editionNo: number | null;          // 工作版为 null
  version: number;                   // 乐观锁版本号（快照侧为发布当时版本）
  baseMsId: number | null;
  baseMsName: string | null;
  publishedVer: number;
  groupCount: number;
  brokenCount: number;
  createdAt?: string;                // 旧版发布时间
}

export type DiffTokenOp = 'equal' | 'added' | 'removed';

export interface DiffToken {
  op: DiffTokenOp;
  text: string;
}

/** 行文增删改：按抄本 + 该抄本原始行号呈现。 */
export interface LineDiff {
  msId: number;
  msName: string;
  lineNo: number;
  status: 'changed' | 'added' | 'removed';
  oldLineId: number | null;
  newLineId: number | null;
  oldText: string;
  newText: string;
  segments: DiffToken[];             // 码点级 LCS 增删改片段
}

export type CellStateKind = 'absent' | 'missing' | 'fragment';

export interface CellChange {
  msId: number;
  msName: string;
  isBase: boolean;
  oldState: CellStateKind;
  newState: CellStateKind;
  /** 变化项：state=片段有无/缺文切换；location=行号或码点区间；text=确定文字；broken=待修复状态 */
  changes: Array<'state' | 'location' | 'text' | 'broken'>;
  /** 仅当两侧片段均在行内（非越界/失效）时才对确定文字下结论。 */
  textChanged: boolean;
  oldOutOfBounds: boolean;
  newOutOfBounds: boolean;
  oldText: string | null;
  newText: string | null;
  newVisibleText: string | null;
  newOobEnd: number | null;
  oldBroken: boolean;
  newBroken: boolean;
  oldLineNo: number | null;
  newLineNo: number | null;
  oldStartCp: number | null;
  newStartCp: number | null;
  oldEndCp: number | null;
  newEndCp: number | null;
}

export interface PairedGroupDiff {
  status: 'same' | 'changed';
  oldGroupId: number;
  newGroupId: number;
  oldOrd: number;
  newOrd: number;
  ordChanged: boolean;
  oldBroken: boolean;
  newBroken: boolean;
  baseMsId: number;
  /** 两侧唯一对应的底本片段位置（配对依据）。 */
  baseLocation: { lineNo: number; startCp: number; endCp: number };
  cellChanges: CellChange[];
}

export interface UnpairedCell {
  msId: number;
  msName: string;
  isBase: boolean;
  state: CellStateKind;
  broken: boolean;
  /** 片段自身越界 / 引用失效（其文字不得作为确定文字）。 */
  outOfBounds: boolean;
  /** 行内片段的确定文字；越界/失效时为 null。 */
  text: string | null;
  /** 越界前尚可见的文字（不确定，仅供参考）。 */
  visibleText: string | null;
  lineNo: number | null;
  startCp: number | null;
  endCp: number | null;
  oobEnd: number | null;
}

export interface UnpairedGroupDiff {
  side: 'old' | 'new';
  groupId: number;
  ord: number;
  broken: boolean;
  /**
   * 未配对原因：
   * base-differs 两侧底本不同；no-base-location 该侧无可用底本片段位置；
   * duplicate-location 同一底本位置在该侧不唯一；not-matched 另一侧无同位置组。
   */
  reason: 'base-differs' | 'no-base-location' | 'duplicate-location' | 'not-matched';
  baseMsId: number | null;
  baseText: string | null;
  baseLocation: { lineNo: number; startCp: number; endCp: number } | null;
  cells: UnpairedCell[];
}

export interface EditionDiff {
  documentId: number;
  title: string;
  /** 服务端生成时刻：刷新对照即可获得当前最新工作版结果。 */
  generatedAt: string;
  sides: { old: DiffSideInfo; new: DiffSideInfo };
  baseSame: boolean;
  pairingNote: string;
  manuscripts: Array<{
    msId: number;
    name: string;
    inOld: boolean;
    inNew: boolean;
    oldPosition: number | null;
    newPosition: number | null;
    isOldBase: boolean;
    isNewBase: boolean;
  }>;
  textChanges: LineDiff[];
  textChangeCounts: { manuscriptCount: number; changed: number; added: number; removed: number };
  groupDiff: {
    paired: PairedGroupDiff[];
    unpairedOld: UnpairedGroupDiff[];
    unpairedNew: UnpairedGroupDiff[];
    counts: { paired: number; pairedChanged: number; unpairedOld: number; unpairedNew: number };
  };
}
