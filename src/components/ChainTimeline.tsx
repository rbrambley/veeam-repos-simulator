import React, { useMemo, useState } from 'react';
import { VeeamSimulator } from '../simulator/engine';
import { BackupChain, RestorePoint, SOBRTier } from '../models/veeam';

interface ChainTimelineProps {
  sim: VeeamSimulator;
  currentDate: string;
  onSelectRestorePoint?: (id: string) => void;
}

const TYPE_COLOR: Record<string, string> = {
  Full: '#1e6bb8',
  Incremental: '#2e7d32',
  SyntheticFull: '#6a1b9a',
};

// GFS flag colors — match the badge colors shown in the tooltip
const GFS_FLAG_COLORS = {
  yearly:  '#b71c1c',
  monthly: '#6a1b9a',
  weekly:  '#1565c0',
};

function getGfsDotColor(rp: RestorePoint): string {
  if (rp.isYearlyGFS)  return GFS_FLAG_COLORS.yearly;
  if (rp.isMonthlyGFS) return GFS_FLAG_COLORS.monthly;
  if (rp.isWeeklyGFS)  return GFS_FLAG_COLORS.weekly;
  return '#888';
}

function getGfsLabel(rp: RestorePoint): string {
  const flags: string[] = [];
  if (rp.isYearlyGFS)  flags.push('Y');
  if (rp.isMonthlyGFS) flags.push('M');
  if (rp.isWeeklyGFS)  flags.push('W');
  return flags.join('');
}

const TYPE_SHAPE: Record<string, string> = {
  Full: 'diamond',
  Incremental: 'circle',
  SyntheticFull: 'diamond',
};

const TIER_BAND_FILL: Record<string, string> = {
  Performance: 'rgba(25, 118, 210, 0.14)',
  Capacity:    'rgba(56, 142, 60, 0.14)',
  Archive:     'rgba(123, 31, 162, 0.14)',
};

const TIER_BAND_STROKE_COLOR: Record<string, string> = {
  Performance: 'rgba(25, 118, 210, 0.45)',
  Capacity:    'rgba(56, 142, 60, 0.45)',
  Archive:     'rgba(123, 31, 162, 0.45)',
};

const TIER_LABEL_COLOR: Record<string, string> = {
  Performance: '#1976d2',
  Capacity:    '#388e3c',
  Archive:     '#7b1fa2',
};

interface TooltipInfo {
  mouseX: number;
  mouseY: number;
  rp: RestorePoint;
}

interface TierSegment {
  tier: string;
  startMs: number;
  endMs: number;
}

interface GenerationSnapshot {
  id: string;
  deleteOn: string;
  performanceImmutableUntil?: string;
  capacityImmutableUntil?: string;
  archiveImmutableUntil?: string;
  lifecycleState: 'DeleteOn Pending' | 'Waiting Immutability' | 'Deletable';
}

export const ChainTimeline: React.FC<ChainTimelineProps> = ({ sim, currentDate, onSelectRestorePoint }) => {
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [timeWindowDays, setTimeWindowDays] = useState<number | 'all'>(90);
  const currentDateMs = new Date(`${currentDate}T00:00:00.000Z`).getTime();

  function formatGenerationStateLabel(state: GenerationSnapshot['lifecycleState']): string {
    return state === 'DeleteOn Pending' ? 'Locked' : state;
  }

  function formatRpId(id: string): string {
    return id.replace(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '');
  }

  const allPoints = sim.state.restorePoints;
  const generations = sim.getCurrentGenerations(currentDate) as GenerationSnapshot[];
  const generationById = useMemo(
    () => Object.fromEntries(generations.map(gen => [gen.id, gen])) as Record<string, GenerationSnapshot>,
    [generations]
  );
  const chainById = useMemo(
    () => Object.fromEntries(sim.state.chains.map(chain => [chain.id, chain])) as Record<string, BackupChain>,
    [sim.state.chains]
  );
  const jobById = useMemo(
    () => Object.fromEntries(sim.state.jobs.map(job => [job.id, job])) as Record<string, { repositoryId: string }>,
    [sim.state.jobs]
  );
  const repoById = useMemo(
    () => Object.fromEntries(sim.state.repositories.map(repo => [repo.id, repo])) as Record<string, { type: string; immutabilityDays?: number }>,
    [sim.state.repositories]
  );
  if (allPoints.length === 0) return null;

  function getImmutabilityStatus(rp: RestorePoint) {
    const tier: SOBRTier = rp.hasArchiveData ? 'Archive' : (rp.hasCapacityData ? 'Capacity' : 'Performance');
    const chain = chainById[rp.chainId];
    const job = chain ? jobById[chain.jobId] : sim.state.jobs[0];
    const repo = job ? repoById[job.repositoryId] : undefined;

    if (repo?.type === 'SOBR' && rp.generationId && generationById[rp.generationId]) {
      const gen = generationById[rp.generationId];
      const immutableUntil = tier === 'Performance'
        ? gen.performanceImmutableUntil
        : tier === 'Capacity'
          ? gen.capacityImmutableUntil
          : gen.archiveImmutableUntil;

      if (!immutableUntil) {
        return { label: 'N/A', detail: `${tier} immutability not configured`, isLocked: null as boolean | null };
      }

      const isLocked = new Date(`${immutableUntil}T00:00:00.000Z`).getTime() >= currentDateMs;
      return {
        label: isLocked ? 'Locked' : 'Unlocked',
        detail: isLocked ? `${tier} lock until ${immutableUntil}` : `${tier} lock expired ${immutableUntil}`,
        isLocked,
      };
    }

    const immutabilityDays = Math.max(0, repo?.immutabilityDays ?? 0);
    if (immutabilityDays <= 0) {
      return { label: 'N/A', detail: 'Primary immutability not configured', isLocked: null as boolean | null };
    }

    const unlockIso = new Date(new Date(`${rp.date}T00:00:00.000Z`).getTime() + immutabilityDays * 86400000).toISOString().slice(0, 10);
    const isLocked = new Date(`${unlockIso}T00:00:00.000Z`).getTime() >= currentDateMs;
    return {
      label: isLocked ? 'Locked' : 'Unlocked',
      detail: isLocked ? `Primary lock until ${unlockIso}` : `Primary lock expired ${unlockIso}`,
      isLocked,
    };
  }

  const allDates = allPoints.map(rp => rp.date).sort();
  const overallMinDate = allDates[0];
  const maxDataDate = allDates[allDates.length - 1];
  const overallMinTime = new Date(`${overallMinDate}T00:00:00.000Z`).getTime();
  const currentTime = new Date(`${currentDate}T00:00:00.000Z`).getTime();

  // Add right-side padding so today sits inset (~12% of window width into the right),
  // keeping threshold markers visible instead of today being pinned to the right wall.
  const windowDaysNum = timeWindowDays === 'all' ? 0 : (timeWindowDays as number);
  const rightPadDays  = timeWindowDays === 'all' ? 10 : Math.max(5, Math.round(windowDaysNum * 0.12));
  const rightPadMs    = rightPadDays * 86400000;

  // Ensure today (plus padding) is always within the window
  const maxTime = Math.max(new Date(`${maxDataDate}T00:00:00.000Z`).getTime(), currentTime) + rightPadMs;

  const windowStartTime = timeWindowDays === 'all'
    ? overallMinTime
    : Math.max(overallMinTime, maxTime - (timeWindowDays as number) * 86400000);
  const minTime = windowStartTime;
  const minDate = new Date(windowStartTime).toISOString().slice(0, 10);
  const span = maxTime - minTime || 1;

  function isInWindow(date: string): boolean {
    const t = new Date(`${date}T00:00:00.000Z`).getTime();
    return t >= minTime && t <= maxTime;
  }

  // SOBR config — needed for threshold lines
  const sobrRepo = sim.state.repositories.find(r => r.type === 'SOBR' && r.sobrConfig);
  const sobrCfg = sobrRepo?.sobrConfig;
  const offloadDays      = sobrCfg?.offloadAfterDays  ?? 0;
  const archiveAfterDays = sobrCfg?.archiveAfterDays  ?? 0;
  const hasArchiveTier   = !!sobrCfg?.hasArchiveTier;
  const moveEnabled      = sobrCfg?.moveEnabled ?? true;

  // Chains sorted oldest-first
  const chains: BackupChain[] = sim.state.chains
    .slice()
    .sort((a, b) => {
      const aFirst = a.restorePoints[0]?.date ?? '';
      const bFirst = b.restorePoints[0]?.date ?? '';
      return aFirst.localeCompare(bFirst);
    });

  const chainRows = chains
    .map(chain => {
      const pts = chain.restorePoints
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .filter(rp => isInWindow(rp.date));
      return { chain, pts };
    })
    .filter(row => row.pts.length > 0);

  const orphanPoints = allPoints
    .filter(rp => rp.chainId.startsWith('gfs-'))
    .filter(rp => isInWindow(rp.date));
  const hasOrphans = orphanPoints.length > 0;

  // Layout constants
  const ROW_HEIGHT  = 52;
  const DOT_R       = 8;
  const LABEL_W     = 110;
  const TIMELINE_W  = 900;
  const TIER_BAND_H = 6;
  const TOTAL_ROWS  = chainRows.length + (hasOrphans ? 1 : 0);
  const SVG_H       = Math.max(60, TOTAL_ROWS * ROW_HEIGHT + 30);
  const totalW      = LABEL_W + TIMELINE_W + 20;

  function xPos(date: string): number {
    const t = new Date(`${date}T00:00:00.000Z`).getTime();
    return LABEL_W + ((t - minTime) / span) * TIMELINE_W;
  }

  function xPosMs(ms: number): number {
    return LABEL_W + ((ms - minTime) / span) * TIMELINE_W;
  }

  function yPos(rowIndex: number): number {
    return rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2 + 10;
  }

  // Return a single band segment covering the chain's visible span in its CURRENT tier colour.
  // (A P→C split was tried but confused users because the transition date ≠ today's rolling threshold.)
  function getTierSegments(chain: BackupChain): TierSegment[] {
    const pts = chain.restorePoints.slice().sort((a, b) => a.date.localeCompare(b.date));
    if (pts.length === 0) return [];

    const bandStartMs = new Date(`${pts[0].date}T00:00:00.000Z`).getTime();
    const bandEndMs   = currentTime;

    // Determine current tier from the most-recently-transitioned point
    const hasArchive  = pts.some(p => p.hasArchiveData);
    const hasCapacity = pts.some(p => p.hasCapacityData);
    const currentTier = hasArchive ? 'Archive' : hasCapacity ? 'Capacity' : 'Performance';

    const startMs = Math.max(bandStartMs, minTime);
    const endMs   = Math.min(bandEndMs,   maxTime);
    if (endMs <= startMs) return [];
    return [{ tier: currentTier, startMs, endMs }];
  }

  // Render a single restore point dot — click-enabled
  function renderDot(rp: RestorePoint, cx: number, cy: number, key: string) {
    const color = rp.isGFS ? getGfsDotColor(rp) : (TYPE_COLOR[rp.type] ?? '#888');
    const isDialog = TYPE_SHAPE[rp.type] === 'diamond';
    const gfsLabel = rp.isGFS ? getGfsLabel(rp) : '';
    const gfsFontSize = gfsLabel.length >= 3 ? 5 : gfsLabel.length === 2 ? 6 : 7;
    const imm = getImmutabilityStatus(rp);
    const lockBadgeText = imm.isLocked === true ? 'L' : imm.isLocked === false ? 'U' : '';
    const lockBadgeStyle = imm.isLocked === true
      ? { bg: '#1565c0', fg: '#fff' }
      : imm.isLocked === false
        ? { bg: '#1b5e20', fg: '#fff' }
        : { bg: 'transparent', fg: 'transparent' };

    const handleMouseEnter = (e: React.MouseEvent<SVGElement>) => setTooltip({ mouseX: e.clientX, mouseY: e.clientY, rp });
    const handleMouseMove  = (e: React.MouseEvent<SVGElement>) => setTooltip(prev => prev ? { ...prev, mouseX: e.clientX, mouseY: e.clientY } : null);
    const handleMouseLeave = () => setTooltip(null);
    const handleClick      = () => { if (onSelectRestorePoint) onSelectRestorePoint(rp.id); };

    if (isDialog) {
      const s = DOT_R + 2;
      const pts = `${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`;
      const sO = DOT_R + 5;
      const ptsO = `${cx},${cy - sO} ${cx + sO},${cy} ${cx},${cy + sO} ${cx - sO},${cy}`;
      return (
        <g key={key}
          onMouseEnter={handleMouseEnter} onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave} onClick={handleClick}
          style={{ cursor: 'pointer' }}
        >
          {rp.isGlobalBase && <polygon points={ptsO} fill="none" stroke="#37474f" strokeWidth={1.5} />}
          {rp.isGFS && <polygon points={pts} fill="none" stroke="#f9a825" strokeWidth={3} />}
          <polygon points={pts} fill={color} opacity={0.9} />
          {gfsLabel && <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={gfsFontSize} fill="#fff" fontWeight="bold">{gfsLabel}</text>}
          {lockBadgeText && (
            <g>
              <rect x={cx + DOT_R - 2} y={cy - DOT_R - 8} width={10} height={10} rx={2} fill={lockBadgeStyle.bg} />
              <text x={cx + DOT_R + 3} y={cy - DOT_R - 3} textAnchor="middle" dominantBaseline="middle" fontSize={6} fill={lockBadgeStyle.fg} fontWeight="bold">{lockBadgeText}</text>
            </g>
          )}
        </g>
      );
    }

    return (
      <g key={key}
        onMouseEnter={handleMouseEnter} onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave} onClick={handleClick}
        style={{ cursor: 'pointer' }}
      >
        {rp.isGFS && <circle cx={cx} cy={cy} r={DOT_R + 3} fill="none" stroke="#f9a825" strokeWidth={2} />}
        <circle cx={cx} cy={cy} r={DOT_R} fill={color} opacity={0.85} />
        {gfsLabel && <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={gfsFontSize} fill="#fff" fontWeight="bold">{gfsLabel}</text>}
        {lockBadgeText && (
          <g>
            <rect x={cx + DOT_R - 2} y={cy - DOT_R - 8} width={10} height={10} rx={2} fill={lockBadgeStyle.bg} />
            <text x={cx + DOT_R + 3} y={cy - DOT_R - 3} textAnchor="middle" dominantBaseline="middle" fontSize={6} fill={lockBadgeStyle.fg} fontWeight="bold">{lockBadgeText}</text>
          </g>
        )}
      </g>
    );
  }

  // X-axis ticks (~12 max)
  function buildTicks(): string[] {
    const ticks: string[] = [];
    const cur = new Date(`${minDate}T00:00:00.000Z`);
    const end = new Date(maxTime);
    const totalDays = (end.getTime() - cur.getTime()) / 86400000;
    const step = Math.max(1, Math.ceil(totalDays / 12));
    while (cur <= end) {
      ticks.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + step);
    }
    return ticks;
  }
  const ticks = buildTicks();

  // Vertical line positions
  const todayX    = xPosMs(currentTime);
  const offloadMs = currentTime - offloadDays * 86400000;
  const archiveMs = currentTime - (offloadDays + archiveAfterDays) * 86400000;
  const offloadX  = (moveEnabled && offloadDays > 0 && offloadMs >= minTime) ? xPosMs(offloadMs) : null;
  const archiveX  = (hasArchiveTier && archiveAfterDays > 0 && archiveMs >= minTime && archiveMs !== offloadMs) ? xPosMs(archiveMs) : null;

  return (
    <div>
      <h3 style={{ marginTop: 0, marginBottom: '0.4rem' }}>Chain Timeline</h3>

      {/* Window selector */}
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.55rem' }}>
        <span style={{ fontSize: '0.82rem', color: '#666', fontWeight: 'bold' }}>Window:</span>
        {([
          { label: '30d',  value: 30 as number | 'all' },
          { label: '90d',  value: 90 as number | 'all' },
          { label: '180d', value: 180 as number | 'all' },
          { label: 'All',  value: 'all' as number | 'all' },
        ]).map(opt => {
          const active = timeWindowDays === opt.value;
          return (
            <button key={opt.label} onClick={() => setTimeWindowDays(opt.value)} style={{
              border: `1px solid ${active ? '#1565c0' : '#ccc'}`,
              background: active ? '#e3f2fd' : '#fff',
              color: active ? '#1565c0' : '#555',
              borderRadius: '999px', fontSize: '0.76rem', fontWeight: 'bold',
              padding: '4px 10px', cursor: 'pointer',
            }}>{opt.label}</button>
          );
        })}
        <span style={{ fontSize: '0.75rem', color: '#888', marginLeft: '0.25rem' }}>
          {timeWindowDays === 'all' ? 'Showing full history' : `Showing last ${timeWindowDays} days`}
        </span>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem', flexWrap: 'wrap', fontSize: '0.8rem', alignItems: 'center' }}>
        {([
          ['Full', '#1e6bb8', 'diamond'] as const,
          ['SyntheticFull / Base Full', '#6a1b9a', 'diamond'] as const,
          ['Incremental', '#2e7d32', 'circle'] as const,
        ]).map(([label, color, shape]) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {shape === 'diamond'
              ? <svg width={14} height={14}><polygon points="7,1 13,7 7,13 1,7" fill={color} /></svg>
              : <svg width={14} height={14}><circle cx={7} cy={7} r={6} fill={color} /></svg>}
            {label}
          </span>
        ))}
        {([['W', GFS_FLAG_COLORS.weekly], ['M', GFS_FLAG_COLORS.monthly], ['Y', GFS_FLAG_COLORS.yearly]] as const).map(([label, clr]) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            <svg width={14} height={14}>
              <polygon points="7,1 13,7 7,13 1,7" fill={clr} opacity={0.9} />
              <text x={7} y={8} textAnchor="middle" dominantBaseline="middle" fontSize={7} fill="#fff" fontWeight="bold">{label}</text>
            </svg>
            GFS-{label === 'W' ? 'Weekly' : label === 'M' ? 'Monthly' : 'Yearly'}
          </span>
        ))}
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <svg width={14} height={14}><polygon points="7,1 13,7 7,13 1,7" fill={GFS_FLAG_COLORS.yearly} opacity={0.9} /><text x={7} y={8} textAnchor="middle" dominantBaseline="middle" fontSize={5} fill="#fff" fontWeight="bold">YM</text></svg>
          Multi-flag
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {(['Performance', 'Capacity', 'Archive'] as const).map(t => (
            <svg key={t} width={18} height={8}><rect x={0} y={0} width={18} height={8} fill={TIER_BAND_FILL[t]} stroke={TIER_BAND_STROKE_COLOR[t]} strokeWidth={0.8} rx={2} /></svg>
          ))}
          Band = current tier (badge = P/C/A)
        </span>
        {offloadX !== null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <svg width={12} height={14}><line x1={6} y1={0} x2={6} y2={14} stroke="#f57c00" strokeWidth={1.5} strokeDasharray="3,2" /></svg>
            Offload threshold
          </span>
        )}
        {archiveX !== null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <svg width={12} height={14}><line x1={6} y1={0} x2={6} y2={14} stroke="#7b1fa2" strokeWidth={1.5} strokeDasharray="3,2" /></svg>
            Archive threshold
          </span>
        )}
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <svg width={12} height={14}><line x1={6} y1={0} x2={6} y2={14} stroke="#e53935" strokeWidth={2} strokeDasharray="4,3" /></svg>
          Today
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ background: '#1565c0', color: '#fff', borderRadius: '2px', padding: '0 4px', fontSize: '0.7rem', fontWeight: 'bold' }}>L</span>
          Locked immutability
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ background: '#1b5e20', color: '#fff', borderRadius: '2px', padding: '0 4px', fontSize: '0.7rem', fontWeight: 'bold' }}>U</span>
          Unlocked immutability
        </span>
        {onSelectRestorePoint && (
          <span style={{ fontSize: '0.75rem', color: '#90a4ae', fontStyle: 'italic' }}>Click any dot to select it</span>
        )}
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: '6px', background: '#fafafa' }}>
        <svg width={totalW} height={SVG_H} style={{ display: 'block' }}>

          {/* X-axis grid lines and labels */}
          {ticks.map(d => {
            const x = xPos(d);
            return (
              <g key={d}>
                <line x1={x} y1={10} x2={x} y2={SVG_H - 16} stroke="#e8e8e8" strokeWidth={1} />
                <text x={x} y={SVG_H - 4} textAnchor="middle" fontSize={9} fill="#bbb">{d.slice(5)}</text>
              </g>
            );
          })}

          {/* Chain rows */}
          {chainRows.map(({ chain, pts }, rowIdx) => {
            const cy = yPos(rowIdx);
            const isActive = chain.status === 'Active';
            const allChainPts = chain.restorePoints.slice().sort((a, b) => a.date.localeCompare(b.date));
            const chainStartDate  = allChainPts[0]?.date ?? pts[0]?.date ?? '';
            const chainStartShort = chainStartDate ? chainStartDate.slice(5) : '';
            const lineXs = pts.map(rp => xPos(rp.date));
            const tierSegments = getTierSegments(chain);
            const bandY = cy + DOT_R + 3;
            const statusColor = isActive ? '#2e7d32' : '#b26a00';
            const labelColor  = isActive ? '#1565c0' : '#888';
            // Rightmost segment = current tier
            const currentChainTier = tierSegments.length > 0 ? tierSegments[tierSegments.length - 1].tier : 'Performance';
            const tierBadgeLetter  = currentChainTier === 'Performance' ? 'P' : currentChainTier === 'Capacity' ? 'C' : 'A';
            const tierBadgeColor   = TIER_LABEL_COLOR[currentChainTier];
            const tierBadgeBg      = TIER_BAND_FILL[currentChainTier];
            const tierBadgeStroke  = TIER_BAND_STROKE_COLOR[currentChainTier];

            return (
              <g key={chain.id}>
                {/* Row background */}
                <rect x={0} y={cy - ROW_HEIGHT / 2 + 2} width={totalW} height={ROW_HEIGHT - 4}
                  fill={isActive ? '#f0f7ff' : '#f9f9f9'} rx={3} />

                {/* Tier band — single colour = current tier the chain is in right now */}
                {tierSegments.map((seg, si) => {
                  const bx = Math.max(LABEL_W, xPosMs(seg.startMs));
                  const bw = Math.min(xPosMs(seg.endMs), LABEL_W + TIMELINE_W) - bx;
                  if (bw <= 0) return null;
                  const tierLetter = seg.tier === 'Performance' ? 'P' : seg.tier === 'Capacity' ? 'C' : 'A';
                  const midX = bx + bw / 2;
                  return (
                    <g key={`band-${si}`}>
                      <rect x={bx} y={bandY} width={bw} height={TIER_BAND_H}
                        fill={TIER_BAND_FILL[seg.tier] ?? 'transparent'}
                        stroke={TIER_BAND_STROKE_COLOR[seg.tier] ?? 'none'}
                        strokeWidth={0.6} rx={2} />
                      {bw >= 14 && (
                        <text x={midX} y={bandY + TIER_BAND_H / 2 + 0.5}
                          textAnchor="middle" dominantBaseline="middle"
                          fontSize={6} fill={TIER_LABEL_COLOR[seg.tier]} fontWeight="bold" opacity={0.85}>
                          {tierLetter}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Chain label: status dot + name + current-tier badge + start date + point count */}
                <circle cx={8} cy={cy - 7} r={4} fill={statusColor} opacity={0.85} />
                <text x={16} y={cy - 7} dominantBaseline="middle" fontSize={9} fill={labelColor} fontWeight={isActive ? 'bold' : 'normal'}>
                  Chain {rowIdx + 1}
                </text>
                {/* Current tier badge */}
                <rect x={7} y={cy + 1} width={14} height={10} rx={2}
                  fill={tierBadgeBg} stroke={tierBadgeStroke} strokeWidth={0.8} />
                <text x={14} y={cy + 6} textAnchor="middle" dominantBaseline="middle"
                  fontSize={7} fill={tierBadgeColor} fontWeight="bold">
                  {tierBadgeLetter}
                </text>
                <text x={8} y={cy + 16} dominantBaseline="middle" fontSize={8} fill="#bbb">
                  {chainStartShort} · {pts.length}pt
                </text>

                {/* Connector line */}
                {lineXs.length > 1 && (
                  <line x1={lineXs[0]} y1={cy} x2={lineXs[lineXs.length - 1]} y2={cy}
                    stroke={isActive ? '#90caf9' : '#ccc'} strokeWidth={2}
                    strokeDasharray={isActive ? undefined : '4,3'} />
                )}

                {/* Restore point dots */}
                {pts.map(rp => renderDot(rp, xPos(rp.date), cy, rp.id))}
              </g>
            );
          })}

          {/* GFS orphan row */}
          {hasOrphans && (() => {
            const rowIdx = chainRows.length;
            const cy = yPos(rowIdx);
            const pts = orphanPoints.slice().sort((a, b) => a.date.localeCompare(b.date));
            const bandY = cy + DOT_R + 3;
            return (
              <g key="gfs-orphans">
                <rect x={0} y={cy - ROW_HEIGHT / 2 + 2} width={totalW} height={ROW_HEIGHT - 4}
                  fill="#fffde7" rx={3} />
                {pts.map(p => {
                  const tier: string = p.hasArchiveData ? 'Archive' : (p.hasCapacityData ? 'Capacity' : 'Performance');
                  const bx = Math.max(LABEL_W, xPos(p.date) - DOT_R);
                  const bw = DOT_R * 2;
                  return (
                    <rect key={`orphan-band-${p.id}`} x={bx} y={bandY} width={bw} height={TIER_BAND_H}
                      fill={TIER_BAND_FILL[tier]} stroke={TIER_BAND_STROKE_COLOR[tier]} strokeWidth={0.6} rx={2} />
                  );
                })}
                <circle cx={8} cy={cy - 7} r={4} fill="#f9a825" opacity={0.85} />
                <text x={16} y={cy - 7} dominantBaseline="middle" fontSize={9} fill="#c68000" fontWeight="bold">
                  GFS Preserved
                </text>
                <text x={8} y={cy + 9} dominantBaseline="middle" fontSize={8} fill="#bbb">
                  {pts.length} pts
                </text>
                {pts.map(rp => renderDot(rp, xPos(rp.date), cy, rp.id))}
              </g>
            );
          })()}

          {/* Threshold lines — rendered after chain rows so labels sit on top of row backgrounds */}
          {offloadX !== null && (
            <g>
              <line x1={offloadX} y1={8} x2={offloadX} y2={SVG_H - 18} stroke="#f57c00" strokeWidth={1.5} strokeDasharray="5,3" opacity={0.7} />
              <text x={offloadX + 3} y={14} fontSize={8} fill="#f57c00">Offload ↙</text>
            </g>
          )}
          {archiveX !== null && (
            <g>
              <line x1={archiveX} y1={8} x2={archiveX} y2={SVG_H - 18} stroke="#7b1fa2" strokeWidth={1.5} strokeDasharray="5,3" opacity={0.7} />
              <text x={archiveX + 3} y={23} fontSize={8} fill="#7b1fa2">Archive ↙</text>
            </g>
          )}

          {/* Today line — rendered last so it sits on top */}
          {todayX >= LABEL_W && todayX <= LABEL_W + TIMELINE_W && (
            <g>
              <line x1={todayX} y1={8} x2={todayX} y2={SVG_H - 18} stroke="#e53935" strokeWidth={2} strokeDasharray="5,3" />
              <text x={todayX + 3} y={SVG_H - 20} fontSize={8} fill="#e53935" fontWeight="bold">Today</text>
            </g>
          )}

        </svg>
      </div>

      {/* Tooltip */}
      {tooltip && (() => {
        const rp = tooltip.rp;
        const currentTier: SOBRTier = rp.hasArchiveData ? 'Archive' : (rp.hasCapacityData ? 'Capacity' : 'Performance');
        const sizeTB = sim.getRestorePointSizeForTier(rp.id, currentTier);
        const gen = rp.generationId ? generationById[rp.generationId] : undefined;
        const imm = getImmutabilityStatus(rp);
        return (
          <div style={{
            position: 'fixed', left: tooltip.mouseX + 14, top: tooltip.mouseY - 10,
            pointerEvents: 'none', zIndex: 9999,
            background: '#fff', border: '1px solid #ccc', borderRadius: '6px',
            padding: '8px 12px', fontSize: '0.85rem',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)', minWidth: '210px',
          }}>
            <div style={{ fontWeight: 'bold', marginBottom: '3px' }}>
              {rp.isGlobalBase ? 'Base Full' : rp.type}
              {rp.isGlobalBase && rp.type === 'SyntheticFull' && (
                <span style={{ fontWeight: 'normal', color: '#90a4ae', fontSize: '0.77rem', marginLeft: '5px' }}>
                  (created as SyntheticFull)
                </span>
              )}
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: '0.77rem', color: '#90a4ae', marginBottom: '5px' }}>
              {formatRpId(rp.id)}
            </div>
            <div>Date: <strong>{rp.date}</strong></div>
            <div>Size: <strong>{sizeTB.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TB</strong></div>
            <div>Tier: <strong style={{ color: TIER_LABEL_COLOR[currentTier] }}>{currentTier}</strong></div>
            {rp.generationId && <div>GEN: <strong>{formatRpId(rp.generationId)}</strong></div>}
            {gen && <div>DeleteOn: <strong>{gen.deleteOn}</strong></div>}
            {gen && <div>State: <strong>{formatGenerationStateLabel(gen.lifecycleState)}</strong></div>}
            <div>Immutability: <strong>{imm.label}</strong></div>
            <div style={{ fontSize: '0.76rem', color: '#78909c' }}>{imm.detail}</div>
            {rp.isGFS && (
              <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span style={{ color: '#607d8b' }}>GFS:</span>
                {rp.isWeeklyGFS  && <span style={{ background: '#1565c0', color: '#fff', borderRadius: '3px', padding: '1px 5px', fontSize: '0.75rem' }}>W</span>}
                {rp.isMonthlyGFS && <span style={{ background: '#6a1b9a', color: '#fff', borderRadius: '3px', padding: '1px 5px', fontSize: '0.75rem' }}>M</span>}
                {rp.isYearlyGFS  && <span style={{ background: '#b71c1c', color: '#fff', borderRadius: '3px', padding: '1px 5px', fontSize: '0.75rem' }}>Y</span>}
              </div>
            )}
            {onSelectRestorePoint && (
              <div style={{ marginTop: '6px', fontSize: '0.75rem', color: '#90a4ae', fontStyle: 'italic' }}>
                Click to view details below ↓
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
};
