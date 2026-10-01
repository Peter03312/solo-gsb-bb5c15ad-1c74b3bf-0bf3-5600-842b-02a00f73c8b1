import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { CollationView, SupplyCandidate, SupplyPreview } from '../types';

/**
 * 自动补配：校勘人员选择文献与目标抄本后，按“完好对应组”的底本文字，
 * 在该抄本原始行文中预览补配候选。
 *  - 仅考虑该抄本尚无片段且未标缺文的完好组（待修复组不参与）；
 *  - 候选须为单行内与底本文字按 Unicode 码点完整相同的文字，
 *    且不占用任何现有片段区间；
 *  - 无候选 / 多候选 / 与其他组候选区间重叠时显示原因；
 *  - 仅“唯一且无冲突”的候选标记为可直接采纳；其余人工择一或跳过；
 *  - 提交时连同预览版本号一并送服务端在当前工作版重新核对，
 *    版本过期（409 版本已过期）或候选失效（409 CANDIDATE_STALE）均整批拒绝。
 */

interface Choice {
  groupId: number;
  candidate: SupplyCandidate;
}

export function SupplyTab({
  view,
  version,
  reload,
  onError,
  onNotice,
}: {
  view: CollationView;
  version: number;
  reload: () => Promise<void>;
  onError: (msg: string, details?: unknown) => void;
  onNotice: (msg: string) => void;
}) {
  const targets = view.manuscripts.filter((m) => m.id !== view.document.baseMsId);
  const [targetMsId, setTargetMsId] = useState<number | null>(targets[0]?.id ?? null);
  const [preview, setPreview] = useState<SupplyPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [busy, setBusy] = useState(false);

  const fetchPreview = async (msId: number) => {
    setLoading(true);
    setPreview(null);
    setChoices({});
    try {
      const p = await api.supplyPreview(view.document.id, msId);
      setPreview(p);
      // 可直接采纳的候选默认勾选，人工仍可取消
      const auto: Record<number, Choice> = {};
      for (const g of p.groups) {
        if (g.adoptable && g.candidates.length === 1) {
          auto[g.groupId] = { groupId: g.groupId, candidate: g.candidates[0] };
        }
      }
      setChoices(auto);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (targetMsId != null) fetchPreview(targetMsId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMsId]);

  // 候选高亮区间（合并到目标抄本各行；点击可选中该候选）
  const marksByLine = useMemo(() => {
    const map = new Map<number, Array<{ startCp: number; endCp: number; kind: string; cand: SupplyCandidate; groupId: number }>>();
    if (!preview) return map;
    for (const g of preview.groups) {
      for (const c of g.candidates) {
        const kind = g.adoptable
          ? 'adopt'
          : c.conflictsWith.length > 0
            ? 'conflict'
            : 'multi';
        const arr = map.get(c.lineId) ?? [];
        arr.push({ startCp: c.startCp, endCp: c.endCp, kind, cand: c, groupId: g.groupId });
        map.set(c.lineId, arr);
      }
    }
    return map;
  }, [preview]);

  const targetLines = view.rawByMs.find((r) => r.msId === targetMsId)?.lines ?? [];

  const pick = (groupId: number, cand: SupplyCandidate) =>
    setChoices((prev) => ({ ...prev, [groupId]: { groupId, candidate: cand } }));
  const skipGroup = (groupId: number) =>
    setChoices((prev) => {
      const next = { ...prev };
      delete next[groupId];
      return next;
    });

  const submit = async () => {
    if (!preview) return;
    const selections = Object.values(choices).map((ch) => ({
      groupId: ch.groupId,
      lineId: ch.candidate.lineId,
      startCp: ch.candidate.startCp,
      endCp: ch.candidate.endCp,
    }));
    if (selections.length === 0) {
      onError('未选择任何候选：可直接采纳的候选可一键提交，或在各组中人工择一后再提交。');
      return;
    }
    setBusy(true);
    try {
      // 以“预览时的文献版本号”提交；服务端在当前工作版重新核对
      const r = await api.supplyCommit(view.document.id, preview.version, preview.targetMsId, selections);
      await reload();
      onNotice(`已补配 ${r.adopted} 个片段（未选组与已有片段保持不变）。`);
      await fetchPreview(preview.targetMsId);
    } catch (e) {
      onError((e as Error).message, (e as { details?: unknown }).details);
    } finally {
      setBusy(false);
    }
  };

  if (view.document.baseMsId == null) {
    return <div className="card">尚未选定底本，无法补配。</div>;
  }
  if (targets.length === 0) {
    return <div className="card">除底本外没有其他抄本，无需补配。</div>;
  }

  const previewStale = preview != null && preview.version !== version;

  return (
    <div>
      <div className="notice-box">
        按<strong>完好对应组</strong>的底本文字，在目标抄本的<strong>原始行文</strong>中查找补配候选：
        仅考虑该抄本<strong>尚无片段且未标缺文</strong>的组（待修复组不参与）；候选须为单行内
        <strong>逐字（Unicode 码点）完全相同</strong>、且不占用任何现有片段区间的文字。
        无候选 / 多处候选 / 与其他组候选区间重叠时给出原因；仅<strong>唯一且无冲突</strong>的候选可直接采纳，
        其余请人工择一或跳过。提交时服务端会在当前工作版<strong>重新核对整批</strong>，任一候选失效即全部拒绝、不推进版本。
      </div>

      <div className="card row-flex">
        <strong>目标抄本：</strong>
        <select value={targetMsId ?? ''} onChange={(e) => setTargetMsId(Number(e.target.value))}>
          {targets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}（底本：{view.manuscripts.find((x) => x.id === view.document.baseMsId)?.name}）
            </option>
          ))}
        </select>
        <button onClick={() => targetMsId != null && fetchPreview(targetMsId)} disabled={loading || busy}>
          重新预览
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        {preview && (
          <>
            <span className="muted">
              可补配组 {preview.eligibleGroupCount} · 可直接采纳 {preview.adoptableCount} · 已选 {Object.keys(choices).length}
            </span>
            <button className="primary" disabled={busy || loading || previewStale || Object.keys(choices).length === 0} onClick={submit}>
              提交所选候选
            </button>
          </>
        )}
      </div>

      {previewStale && (
        <div className="error-box">
          ⚠ 工作版已在预览后变化（预览基于 v{preview?.version}，当前 v{version}）。
          请点“重新预览”获取最新候选后再提交；直接提交将被服务端以 409 拒绝。
        </div>
      )}

      {loading && <div className="card muted">候选计算中…</div>}

      {preview && !loading && (
        <>
          <div className="legend">
            候选颜色：
            <span className="sw supply-adopt-bg" />可直接采纳（唯一无冲突）
            <span className="sw supply-multi-bg" />多处候选（需择一）
            <span className="sw supply-conflict-bg" />候选区间冲突
            <span className="sw" style={{ background: '#dcead9' }} />现有片段（已占用）
          </div>

          {preview.groups.length === 0 && (
            <div className="card muted">没有可补配的组：各组要么待修复，要么该抄本已有片段 / 已标缺文。</div>
          )}

          {preview.groups.map((g) => {
            const choice = choices[g.groupId];
            return (
              <div key={g.groupId} className={`draft-card ${g.adoptable ? '' : 'supply-warn'}`}>
                <div className="row-flex">
                  <strong>第 {g.ord} 组</strong>
                  <span className="cell-text">底本「{g.baseText}」</span>
                  {g.adoptable ? (
                    <span className="pill ok">可直接采纳</span>
                  ) : (
                    <span className="pill broken">{reasonLabel(g.reason)}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  {choice && <button disabled={busy} onClick={() => skipGroup(g.groupId)}>跳过（不选）</button>}
                </div>
                {g.reasonText && <div className="muted">{g.reasonText}</div>}
                {g.candidates.length === 0 ? (
                  <div className="muted">无候选，可人工到“对应组归组”处理。</div>
                ) : (
                  <div className="supply-cand-list">
                    {g.candidates.map((c, i) => {
                      const selected =
                        choice?.candidate.lineId === c.lineId &&
                        choice.candidate.startCp === c.startCp &&
                        choice.candidate.endCp === c.endCp;
                      return (
                        <label key={i} className={`supply-cand ${selected ? 'selected' : ''}`}>
                          <input
                            type="radio"
                            name={`supply-${g.groupId}`}
                            checked={selected}
                            disabled={busy}
                            onChange={() => pick(g.groupId, c)}
                          />
                          <span>
                            第 {c.lineNo} 行 · 第 {c.startCp + 1}–{c.endCp} 字 ·「{c.text}」
                          </span>
                          {c.conflictsWith.length > 0 && (
                            <span className="pill broken">
                              与 {c.conflictsWith.map((x) => `第${x.ord}组`).join('、')} 候选重叠
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* 目标抄本原始行文：现有片段 + 候选区间高亮，点击候选即选中 */}
          <div className="raw-section">
            <h3>
              {preview.targetMsName}原文（原始行序；点击高亮候选即选中该候选）
            </h3>
            <div className="ms-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="ms-panel">
                <div className="ms-body" style={{ maxHeight: 480 }}>
                  {targetLines.map((l) => {
                    const marks = (marksByLine.get(l.lineId) ?? []).slice().sort((a, b) => a.startCp - b.startCp);
                    return (
                      <div className="line-row" key={l.lineId}>
                        <span className="line-no">{l.lineNo}.</span>
                        <span className="line-text">
                          {Array.from(l.content).map((ch, i) => {
                            const cov = l.covered.find((c) => i >= c.startCp && i < c.endCp);
                            const mark = marks.find((m) => i >= m.startCp && i < m.endCp);
                            const markOrd = mark
                              ? preview.groups.find((g) => g.groupId === mark.groupId)?.ord
                              : undefined;
                            const cls =
                              'ch' +
                              (cov ? (cov.broken ? ' cov-broken' : ' cov') : '') +
                              (mark ? ` supply-${mark.kind}` : '');
                            return (
                              <span
                                key={i}
                                className={cls}
                                title={mark ? `第 ${markOrd ?? '?'} 组候选` : undefined}
                                onClick={mark ? () => pick(mark.groupId, mark.cand) : undefined}
                                style={mark ? { cursor: 'pointer' } : undefined}
                              >
                                {ch}
                              </span>
                            );
                          })}
                        </span>
                      </div>
                    );
                  })}
                  {targetLines.length === 0 && <div className="muted">该抄本尚无行。</div>}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function reasonLabel(reason: SupplyPreview['groups'][number]['reason']): string {
  switch (reason) {
    case 'no-candidate':
      return '无候选';
    case 'multiple-candidates':
      return '多处候选·择一';
    case 'candidate-conflict':
      return '候选冲突·择一';
    default:
      return '需人工处理';
  }
}
