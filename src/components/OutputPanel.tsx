import React, { useMemo, useState } from 'react';
import { VeeamSimulator } from '../simulator/engine';
import { ChainTimeline } from './ChainTimeline';
import { StateLegend } from './StateLegend';
import { computeVeeamWorkingSpaceTB } from '../models/veeam';
import { normalizeForecastYears } from '../models/forecast';

interface OutputPanelProps {
  sim: VeeamSimulator;
  currentDate: string;
  onNextDay: (days?: number) => void;
}

interface RestorePointRow {
  id: string;
  chainId: string;
  generationId?: string;
  type: string;
  date: string;
  sizeGB: number;
  isGFS: boolean;
  isGlobalBase?: boolean;
  isWeeklyGFS: boolean;
  isMonthlyGFS: boolean;
  isYearlyGFS: boolean;
  sobrTier?: string;
  isTierSeed?: boolean;
  baseTiers?: string[];
  representsRestorePointId?: string;
  representsRestorePointDate?: string;
  tierMoveHistory?: Array<{ tier: string; date: string }>;
  hasPerformanceData?: boolean;
  hasCapacityData?: boolean;
  hasArchiveData?: boolean;
  capacityCopyCreatedAt?: string;
  capacityMoveFinalizedAt?: string;
}

interface GenerationSnapshot {
  id: string;
  jobId: string;
  chainId: string;
  windowStartDate: string;
  windowEndDate: string;
  deleteOn: string;
  pointIds: string[];
  performanceImmutableUntil?: string;
  capacityImmutableUntil?: string;
  archiveImmutableUntil?: string;
  hasPerformanceData: boolean;
  hasCapacityData: boolean;
  hasArchiveData: boolean;
  deleteOnReached: boolean;
  performanceLocked: boolean;
  capacityLocked: boolean;
  archiveLocked: boolean;
  immutabilityLocked: boolean;
  lifecycleState: 'DeleteOn Pending' | 'Waiting Immutability' | 'Deletable';
}

type InsightPriority = 'high' | 'medium' | 'low' | 'info';

interface PolicyInsightItem {
  id: string;
  priority: InsightPriority;
  finding: string;
  impact: string;
  evidence: string;
  recommendation?: string;
}

interface PolicyInsightModel {
  title: string;
  offloadDays: number;
  retentionDays: number;
  oldestInactiveDays: number;
  items: PolicyInsightItem[];
  contextNotes: string[];
  highestPriority: InsightPriority;
}

const PRIORITY_RANK: Record<InsightPriority, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function getHighestPriority(items: PolicyInsightItem[]): InsightPriority {
  if (items.length === 0) return 'info';
  return items.reduce((highest, item) => (
    PRIORITY_RANK[item.priority] > PRIORITY_RANK[highest] ? item.priority : highest
  ), 'info' as InsightPriority);
}

export const OutputPanel: React.FC<OutputPanelProps> = ({ sim, currentDate, onNextDay }) => {
  const [showChainTimeline, setShowChainTimeline] = useState(true);
  const [showRestoreCatalog, setShowRestoreCatalog] = useState(true);
  const [showTierContents, setShowTierContents] = useState(true);
  const [activityLogFilter, setActivityLogFilter] = useState<number | null>(null);

  function formatTB(val: number) {
    return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TB';
  }

  function shortId(id: string) {
    if (!id) return '-';
    const compact = id.replace(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '');
    return compact.length > 22 ? `${compact.slice(0, 10)}...${compact.slice(-8)}` : compact;
  }

  function normalizeActivityText(text: string) {
    // Drop verbose midnight UTC timestamp fragment from RP ids for readability.
    return text.replace(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '');
  }

  function wasPrunedFromCapacity(rp: RestorePointRow) {
    const history = rp.tierMoveHistory || [];
    let sawCapacity = false;
    for (const step of history) {
      if (step.tier === 'Capacity') sawCapacity = true;
      if (sawCapacity && step.tier === 'Performance') return true;
    }
    return false;
  }

  function computeDaysToYear(year: number): number {
    const start = sim.state.startDate || currentDate;
    const target = new Date(`${start}T00:00:00.000Z`);
    target.setUTCFullYear(target.getUTCFullYear() + year);
    const now = new Date(`${currentDate}T00:00:00.000Z`);
    return Math.floor((target.getTime() - now.getTime()) / 86400000);
  }

  function getSimulationDayLabel(date: string) {
    const d = new Date(`${date}T00:00:00.000Z`);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weekday = days[d.getUTCDay()];
    return `${date} (${weekday})`;
  }
  
  function getSimulationDayMeta(date: string) {
    const d = new Date(`${date}T00:00:00.000Z`);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weekday = days[d.getUTCDay()];
    return {
      isoDate: date,
      weekday,
      isWeekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
    };
  }

  function parseISODate(date: string) {
    return new Date(`${date}T00:00:00.000Z`);
  }

  const restorePoints: RestorePointRow[] = sim.getCurrentRestorePoints();
  const storageUsage = sim.getStorageUsage();
  const dailyExplanation = sim.getDailyExplanation();
  const [selectedRestorePointId, setSelectedRestorePointId] = useState<string | null>(null);

  const totalUsedTB = Object.values(storageUsage).reduce((sum, used) => sum + used, 0);
  const gfsCount = restorePoints.filter(rp => rp.isGFS).length;
  const activeChains = sim.state.chains.filter(c => c.status === 'Active').length;
  const sortedRestorePoints = useMemo(
    () => restorePoints.slice().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [restorePoints]
  );
  const chainById = Object.fromEntries(sim.state.chains.map(chain => [chain.id, chain]));
  const jobById = useMemo(
    () => Object.fromEntries(sim.state.jobs.map(job => [job.id, job])),
    [sim.state.jobs]
  ) as Record<string, { repositoryId: string; retention?: { restorePoints: number } }>;
  const repoById = useMemo(
    () => Object.fromEntries(sim.state.repositories.map(repo => [repo.id, repo])),
    [sim.state.repositories]
  ) as Record<string, { type: string; immutabilityDays?: number; sobrConfig?: { performanceImmutabilityDays?: number; capacityImmutabilityDays?: number; archiveImmutabilityDays?: number } }>;
  const generationSnapshots = sim.getCurrentGenerations(currentDate) as GenerationSnapshot[];
  const hasGenerationUi = generationSnapshots.length > 0;
  const generationById = useMemo(
    () => Object.fromEntries(generationSnapshots.map(gen => [gen.id, gen])) as Record<string, GenerationSnapshot>,
    [generationSnapshots]
  );

  const currentDateMs = parseISODate(currentDate).getTime();

  function getRestorePointImmutability(rp: RestorePointRow, tierHint?: 'Performance' | 'Capacity' | 'Archive') {
    const chain = chainById[rp.chainId];
    const job = chain ? jobById[chain.jobId] : primaryJob;
    const repo = job ? repoById[job.repositoryId] : primaryRepo;

    if (!repo) {
      return { label: 'N/A', detail: 'Repository not found', isLocked: null as boolean | null };
    }

    if (repo.type === 'SOBR') {
      const sobrConfig = repo.sobrConfig;
      if (!sobrConfig) {
        return { label: 'N/A', detail: 'SOBR config not found', isLocked: null as boolean | null };
      }

      // Use generation-based immutability if available
      if (rp.generationId && generationById[rp.generationId]) {
        const gen = generationById[rp.generationId];
        const tier = tierHint || (rp.sobrTier || 'Performance');
        const immutableUntil = tier === 'Performance'
          ? gen.performanceImmutableUntil
          : tier === 'Capacity'
            ? gen.capacityImmutableUntil
            : gen.archiveImmutableUntil;

        if (!immutableUntil) {
          return { label: 'N/A', detail: `${tier} immutability not configured`, isLocked: null as boolean | null };
        }

        const isLocked = parseISODate(immutableUntil).getTime() >= currentDateMs;
        return {
          label: isLocked ? 'Locked' : 'Unlocked',
          detail: isLocked ? `${tier} lock until ${immutableUntil}` : `${tier} lock expired ${immutableUntil}`,
          isLocked,
        };
      }

      // For SOBR points not yet in a generation, calculate from tier immutability + tier entry date
      const tier = tierHint || (rp.sobrTier || 'Performance');
      const tierEnteredAt = rp.sobrTierEnteredAt || rp.date; // Use tier entry date if available, else creation date
      const tierImmutabilityDays = tier === 'Performance'
        ? sobrConfig.performanceImmutabilityDays ?? 0
        : tier === 'Capacity'
          ? sobrConfig.capacityImmutabilityDays ?? 0
          : sobrConfig.archiveImmutabilityDays ?? 0;

      if (tierImmutabilityDays <= 0) {
        return { label: 'N/A', detail: `${tier} immutability not configured`, isLocked: null as boolean | null };
      }

      const unlockIso = new Date(parseISODate(tierEnteredAt).getTime() + tierImmutabilityDays * 86400000).toISOString().slice(0, 10);
      const isLocked = parseISODate(unlockIso).getTime() >= currentDateMs;
      return {
        label: isLocked ? 'Locked' : 'Unlocked',
        detail: isLocked ? `${tier} lock until ${unlockIso}` : `${tier} lock expired ${unlockIso}`,
        isLocked,
      };
    }

    const immutabilityDays = Math.max(0, repo.immutabilityDays ?? 0);
    if (immutabilityDays <= 0) {
      return { label: 'N/A', detail: 'Primary immutability not configured', isLocked: null as boolean | null };
    }

    const unlockIso = new Date(parseISODate(rp.date).getTime() + immutabilityDays * 86400000).toISOString().slice(0, 10);
    const isLocked = parseISODate(unlockIso).getTime() >= currentDateMs;
    return {
      label: isLocked ? 'Locked' : 'Unlocked',
      detail: isLocked ? `Primary lock until ${unlockIso}` : `Primary lock expired ${unlockIso}`,
      isLocked,
    };
  }

  function renderImmutabilityChip(rp: RestorePointRow, tierHint?: 'Performance' | 'Capacity' | 'Archive') {
    const status = getRestorePointImmutability(rp, tierHint);
    const displayLabel = status.isLocked === true ? 'Protected' : status.isLocked === false ? 'Mutable' : 'N/A';
    const style = status.isLocked === true
      ? { bg: '#e3f2fd', fg: '#1565c0' }
      : status.isLocked === false
        ? { bg: '#e8f5e9', fg: '#1b5e20' }
        : { bg: '#eceff1', fg: '#455a64' };
    return (
      <span title={status.detail} style={{ background: style.bg, color: style.fg, borderRadius: '3px', padding: '1px 6px', fontSize: '0.72rem', fontWeight: 700 }}>
        {displayLabel}
      </span>
    );
  }

  const genSummary = useMemo(() => {
    const total = generationSnapshots.length;
    const locked = generationSnapshots.filter(g => g.immutabilityLocked).length;
    const deletable = generationSnapshots.filter(g => g.lifecycleState === 'Deletable').length;
    const nextDeleteOn = generationSnapshots
      .map(g => g.deleteOn)
      .sort()[0];

    const immutabilityDates = generationSnapshots
      .flatMap(g => [g.performanceImmutableUntil, g.capacityImmutableUntil, g.archiveImmutableUntil])
      .filter((d): d is string => !!d)
      .sort();

    return {
      total,
      locked,
      deletable,
      nextDeleteOn,
      nextImmutabilityExpiry: immutabilityDates[0],
    };
  }, [generationSnapshots]);
  
  const simDateMeta = useMemo(() => {
    const meta = getSimulationDayMeta(currentDate);
    const startDate = sim.state.startDate || currentDate;
    const elapsedDays = Math.max(
      0,
      Math.floor((parseISODate(currentDate).getTime() - parseISODate(startDate).getTime()) / 86400000)
    );
    return {
      ...meta,
      elapsedDays,
    };
  }, [currentDate, sim.state.startDate]);

  const immutabilitySummary = useMemo(() => {
    const primaryJob = sim.state.jobs[0];
    const primaryRepo = primaryJob
      ? sim.state.repositories.find(r => r.id === primaryJob.repositoryId)
      : sim.state.repositories[0];

    if (!primaryRepo) return 'Immutability: Not configured';

    if (primaryRepo.type === 'SOBR' && primaryRepo.sobrConfig) {
      const perf = Math.max(0, primaryRepo.sobrConfig.performanceImmutabilityDays ?? 0);
      const cap = Math.max(0, primaryRepo.sobrConfig.capacityImmutabilityDays ?? 0);
      const archEnabled = !!primaryRepo.sobrConfig.hasArchiveTier;
      const arch = Math.max(0, primaryRepo.sobrConfig.archiveImmutabilityDays ?? 0);
      return archEnabled
        ? `Immutability: Performance ${perf}d | Capacity ${cap}d | Archive ${arch}d`
        : `Immutability: Performance ${perf}d | Capacity ${cap}d | Archive disabled`;
    }

    const primary = Math.max(0, primaryRepo.immutabilityDays ?? 0);
    return `Immutability: Primary ${primary}d`;
  }, [sim.state.jobs, sim.state.repositories]);

  const getGenerationStateStyle = (state: GenerationSnapshot['lifecycleState']) => {
    if (state === 'Deletable') {
      return { color: '#1b5e20', bg: '#e8f5e9' };
    }
    if (state === 'Waiting Immutability') {
      return { color: '#8d6e63', bg: '#efebe9' };
    }
    return { color: '#1565c0', bg: '#e3f2fd' };
  };

  const getGenerationStateLabel = (state: GenerationSnapshot['lifecycleState']) => {
    if (state === 'DeleteOn Pending') return 'Sealed';
    if (state === 'Waiting Immutability') return 'Immutability Hold';
    if (state === 'Deletable') return 'Ready';
    return state;
  };

  const renderGenMetadataLine = (rp: RestorePointRow) => {
    if (!hasGenerationUi || !rp.generationId || !generationById[rp.generationId]) return null;
    const gen = generationById[rp.generationId];
    const stateLabel = getGenerationStateLabel(gen.lifecycleState);
    return (
      <div style={{ fontSize: '0.75rem', color: '#546e7a', marginTop: '2px', fontFamily: 'monospace' }}>
        📋 {shortId(rp.generationId)} ({stateLabel}, DeleteOn {gen.deleteOn})
      </div>
    );
  };

  const renderGenTotals = (locked: number, waiting: number, deletable: number) => (
    <div style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
      <span title="Sealed GENs" style={{ background: '#e3f2fd', color: '#1565c0', borderRadius: '3px', padding: '0 5px', fontSize: '0.72rem', fontWeight: 700 }}>
        S {locked}
      </span>
      <span title="Immutability Hold GENs" style={{ background: '#efebe9', color: '#8d6e63', borderRadius: '3px', padding: '0 5px', fontSize: '0.72rem', fontWeight: 700 }}>
        H {waiting}
      </span>
      <span title="Ready GENs" style={{ background: '#e8f5e9', color: '#1b5e20', borderRadius: '3px', padding: '0 5px', fontSize: '0.72rem', fontWeight: 700 }}>
        R {deletable}
      </span>
    </div>
  );

  const tierBuckets = useMemo(() => ({
    Performance: sortedRestorePoints.filter(rp => {
      // For SOBR, use sobrTier (current location) exclusively, not hasPerformanceData (historical flag)
      return (rp.sobrTier ?? 'Performance') === 'Performance';
    }),
    Capacity: sortedRestorePoints.filter(rp => {
      // For SOBR, use sobrTier (current location) exclusively, not hasCapacityData (historical flag)
      return rp.sobrTier === 'Capacity';
    }),
    Archive: sortedRestorePoints.filter(rp => {
      // For SOBR, use sobrTier (current location) exclusively, not hasArchiveData (historical flag)
      return rp.sobrTier === 'Archive';
    }),
  }), [sortedRestorePoints]);

  const primaryJob = sim.state.jobs[0];
  const primaryRepo = primaryJob
    ? sim.state.repositories.find(r => r.id === primaryJob.repositoryId)
    : sim.state.repositories[0];
  const isPrimaryRepoSobr = !!(primaryRepo?.type === 'SOBR' && primaryRepo?.sobrConfig);
  const visibleTierOrder: Array<'Performance' | 'Capacity' | 'Archive'> = isPrimaryRepoSobr
    ? ['Performance', 'Capacity', 'Archive']
    : ['Performance'];

  const workingSpaceByRepo = useMemo((): Record<string, { totalTB: number; additionalTB: number; largestFullTB: number; pct?: number; initialSourceTB?: number; byTier: Record<string, number>; byTierAdditional: Record<string, number> }> => {
    return Object.fromEntries(sim.state.repositories.map(repo => {
      const repoJob = sim.state.jobs.find(job => job.repositoryId === repo.id);
      if (!repoJob) {
        return [repo.id, {
          totalTB: 0,
          additionalTB: 0,
          largestFullTB: 0,
          pct: 0,
          byTier: { Performance: 0, Capacity: 0, Archive: 0 },
          byTierAdditional: { Performance: 0, Capacity: 0, Archive: 0 },
        }];
      }

      const forecastYears = normalizeForecastYears(repoJob.forecastYears);
      const annualGrowth = (repoJob.annualGrowthRatePct ?? 10) / 100;
      const effectiveSourceTB = (repoJob.sourceDataTB || 1) * Math.pow(1 + annualGrowth, forecastYears);
      const largestFullTB = effectiveSourceTB * 0.5;
      // Working space: Veeam progressive tiered scale on initial source TB (no growth factor)
      const initialSourceTB = repoJob.sourceDataTB || 1;
      const reserveTB = computeVeeamWorkingSpaceTB(initialSourceTB);

      if (repo.type === 'SOBR' && repo.sobrConfig) {
        return [repo.id, {
          totalTB: reserveTB,
          additionalTB: reserveTB,
          largestFullTB,
          initialSourceTB,
          byTier: { Performance: reserveTB, Capacity: 0, Archive: 0 },
          byTierAdditional: { Performance: reserveTB, Capacity: 0, Archive: 0 },
        }];
      }

      return [repo.id, {
        totalTB: reserveTB,
        additionalTB: reserveTB,
        largestFullTB,
        initialSourceTB,
        byTier: { Performance: 0, Capacity: 0, Archive: 0 },
        byTierAdditional: { Performance: 0, Capacity: 0, Archive: 0 },
      }];
    }));
  }, [sim.state.repositories, sim.state.jobs]);

  const totalWorkingSpaceTB = useMemo(
    () => Object.values(workingSpaceByRepo).reduce((sum, ws) => sum + ws.totalTB, 0),
    [workingSpaceByRepo]
  );

  const temporarySpacePlanningItems = useMemo((): PolicyInsightItem[] => {
    const items: PolicyInsightItem[] = [];

    sim.state.repositories.forEach(repo => {
      const usedTB = storageUsage[repo.id] || 0;
      const neededTB = workingSpaceByRepo[repo.id]?.totalTB ?? 0;
      const capacityTB = repo.capacityTB || 0;
      if (capacityTB <= 0) return;

      const combinedTB = usedTB + neededTB;
      const combinedPct = (combinedTB / capacityTB) * 100;
      const freeTB = Math.max(0, capacityTB - usedTB);
      const deficitTB = Math.max(0, neededTB - freeTB);

      if (combinedTB > capacityTB + 0.000001) {
        items.push({
          id: `INS-001-${repo.id}`,
          priority: 'high',
          finding: `Temporary workspace demand exceeds available capacity for repository ${repo.name}.`,
          impact: 'Backup processing can fail or force emergency capacity expansion.',
          evidence: `Used ${usedTB.toFixed(2)} TB + workspace ${neededTB.toFixed(2)} TB > capacity ${capacityTB.toFixed(2)} TB (deficit ${deficitTB.toFixed(2)} TB).`,
          recommendation: `Increase capacity by at least ${deficitTB.toFixed(2)} TB or reduce retention and GFS density.`,
        });
        return;
      }

      if (combinedPct >= 85) {
        items.push({
          id: `INS-002-${repo.id}`,
          priority: 'medium',
          finding: `Repository ${repo.name} is nearing effective capacity limits.`,
          impact: 'Reduced growth headroom increases the risk of cost spikes and policy pressure.',
          evidence: `Used + temporary workspace = ${combinedPct.toFixed(1)}% (${usedTB.toFixed(2)} TB + ${neededTB.toFixed(2)} TB = ${combinedTB.toFixed(2)} TB of ${capacityTB.toFixed(2)} TB).`,
          recommendation: 'Add headroom to target 20-30% free capacity or reduce retention pressure.',
        });
      }
    });

    return items;
  }, [sim.state.repositories, storageUsage, workingSpaceByRepo]);

  const policyInsight = useMemo<PolicyInsightModel | null>(() => {
    const items: PolicyInsightItem[] = [...temporarySpacePlanningItems];
    const contextNotes: string[] = [];
    const repo = sim.state.repositories.find(r => r.type === 'SOBR' && r.sobrConfig);
    if (!repo?.sobrConfig) {
      if (items.length === 0) {
        items.push({
          id: 'INS-009',
          priority: 'info',
          finding: 'No active risks detected for current policy.',
          impact: 'Current temporary-space and retention settings are within configured limits.',
          evidence: 'No repository exceeded 85% temporary-space-adjusted utilization.',
        });
      }
      contextNotes.push('SOBR-specific offload and archive checks are not applicable because no SOBR repository is configured.');
      return {
        title: items.some(item => item.priority === 'high' || item.priority === 'medium' || item.priority === 'low')
          ? 'Policy risks detected in current configuration.'
          : 'No active risks detected for current policy.',
        offloadDays: 0,
        retentionDays: 0,
        oldestInactiveDays: 0,
        items,
        contextNotes,
        highestPriority: getHighestPriority(items),
      };
    }

    const job = sim.state.jobs.find(j => j.repositoryId === repo.id);
    if (!job) return null;

    const copyEnabled = !!repo.sobrConfig.copyEnabled;
    const moveEnabled = repo.sobrConfig.moveEnabled ?? true;
    const offloadDays = Math.max(0, repo.sobrConfig.offloadAfterDays || 0);
    const archiveDays = Math.max(0, repo.sobrConfig.archiveAfterDays || 0);
    const hasArchiveTier = !!repo.sobrConfig.hasArchiveTier;
    const retentionDays = Math.max(0, job.retention?.restorePoints || 0);

    const now = new Date(`${currentDate}T00:00:00.000Z`).getTime();
    const inactiveChains = sim.state.chains.filter(c => c.jobId === job.id && c.status === 'Inactive' && !!c.inactiveSince);
    const inactiveAges = inactiveChains.map(c => {
      const since = new Date(`${c.inactiveSince}T00:00:00.000Z`).getTime();
      return Math.max(0, Math.floor((now - since) / 86400000));
    });

    const oldestInactiveDays = inactiveAges.length > 0 ? Math.max(...inactiveAges) : 0;
    const riskyWindow = moveEnabled && retentionDays > 0 && retentionDays <= offloadDays;

    const inactiveChainStats = inactiveChains.map(chain => {
      const since = new Date(`${chain.inactiveSince}T00:00:00.000Z`).getTime();
      const ageDays = Math.max(0, Math.floor((now - since) / 86400000));
      const points = restorePoints.filter(rp => rp.chainId === chain.id);
      const hasPerformance = points.some(rp => !!rp.hasPerformanceData || ((rp.hasPerformanceData === undefined && rp.hasCapacityData === undefined && rp.hasArchiveData === undefined) && (rp.sobrTier ?? 'Performance') === 'Performance'));
      const hasCapacity = points.some(rp => !!rp.hasCapacityData || rp.sobrTier === 'Capacity');
      const pastThreshold = moveEnabled && ageDays >= offloadDays;
      return { ageDays, hasPerformance, hasCapacity, pastThreshold };
    });

    const overdueInactiveCount = inactiveChainStats.filter(s => s.pastThreshold && s.hasPerformance).length;
    const offloadedInactiveCount = inactiveChainStats.filter(s => s.pastThreshold && !s.hasPerformance && s.hasCapacity).length;
    const eligibleButNotYetOffloaded = inactiveChainStats.filter(s => !s.pastThreshold && s.hasPerformance).length;
    const invalidArchiveOrdering = hasArchiveTier && archiveDays > 0 && archiveDays < offloadDays;

    const performanceImmutabilityDays = Math.max(0, repo.sobrConfig.performanceImmutabilityDays ?? 0);
    const capacityImmutabilityDays = Math.max(0, repo.sobrConfig.capacityImmutabilityDays ?? 0);
    const archiveImmutabilityDays = Math.max(0, repo.sobrConfig.archiveImmutabilityDays ?? 0);

    if (invalidArchiveOrdering) {
      items.push({
        id: 'INS-004',
        priority: 'medium',
        finding: 'Archive timing is configured ahead of offload timing.',
        impact: 'Archive behavior can appear delayed or counterintuitive in Capacity-to-Archive transitions.',
        evidence: `Offload ${offloadDays}d, Archive ${archiveDays}d (archive threshold is shorter than offload threshold).`,
        recommendation: `Set Archive >= Offload + intended Capacity dwell time. Current effective earliest archive age is ${offloadDays + archiveDays}d.`,
      });
    }
    if (riskyWindow) {
      items.push({
        id: 'INS-003',
        priority: 'high',
        finding: 'Retention window is too short for move offload to execute reliably.',
        impact: 'Expected movement from Performance to Capacity may not complete before data expires.',
        evidence: `Retention ${retentionDays}d <= Offload ${offloadDays}d.`,
        recommendation: `Increase retention to at least ${offloadDays + 7}d or lower offload threshold.`,
      });
    }
    if (moveEnabled && overdueInactiveCount > 0) {
      items.push({
        id: 'INS-005',
        priority: 'high',
        finding: 'Inactive chains are overdue for offload.',
        impact: 'Performance tier retains data longer than policy intent, increasing cost pressure.',
        evidence: `${overdueInactiveCount} inactive chain(s) older than ${offloadDays}d still hold Performance data.`,
        recommendation: 'Review offload eligibility constraints and chain-state transitions for blocked movement.',
      });
    }
    if (moveEnabled && !riskyWindow && overdueInactiveCount === 0 && oldestInactiveDays < offloadDays) {
      contextNotes.push(`Oldest inactive chain is ${oldestInactiveDays}d; offload starts at ${offloadDays}d.`);
    }
    if (job.gfsPolicy && hasArchiveTier === false) {
      items.push({
        id: 'INS-006',
        priority: 'medium',
        finding: 'GFS policy is enabled while Archive tier is disabled.',
        impact: 'Long-term GFS points remain in Capacity, increasing cost versus cold-tier storage.',
        evidence: 'GFS is configured and Archive tier is not enabled.',
        recommendation: 'Enable Archive tier for long-term retention points or reduce long-horizon GFS settings.',
      });
    }
    if (hasArchiveTier && !job.gfsPolicy) {
      items.push({
        id: 'INS-007',
        priority: 'medium',
        finding: 'Archive tier is enabled but no GFS policy is configured.',
        impact: 'Archive capacity remains unused while still adding operational complexity.',
        evidence: 'Archive is enabled and all GFS retention counts are effectively zero.',
        recommendation: 'Configure weekly/monthly/yearly GFS retention or disable Archive tier.',
      });
    }
    if (!job.gfsPolicy && !hasArchiveTier) {
      contextNotes.push('No GFS policy configured; weekly, monthly, and yearly retention marks are disabled.');
    }

    const hasAnyGfs = !!job.gfsPolicy && (
      (job.gfsPolicy.weekly ?? 0) > 0 ||
      (job.gfsPolicy.monthly ?? 0) > 0 ||
      (job.gfsPolicy.yearly ?? 0) > 0
    );
    const hasMixedMonthlyYearly = !!job.gfsPolicy && (
      (job.gfsPolicy.monthly ?? 0) > 0 && (job.gfsPolicy.yearly ?? 0) > 0
    );

    // Detect orphan starter chain: GFS is active but job starts on a non-Saturday.
    // The first chain will accumulate points until the next Saturday, then expire
    // through normal retention with no GFS tag — it will never reach Archive.
    if (hasAnyGfs && sim.state.startDate) {
      const startDay = new Date(`${sim.state.startDate}T00:00:00.000Z`).getUTCDay(); // 0=Sun,6=Sat
      if (startDay !== 6) {
        const daysUntilSat = (6 - startDay + 7) % 7;
        contextNotes.push(
          `Job starts on a non-Saturday (${daysUntilSat}d until first GFS tag). ` +
          `The initial chain has no GFS flag and will be removed by retention — it will not archive.`
        );
      }
    }

    if (hasArchiveTier && hasAnyGfs) {
      contextNotes.push(
        hasMixedMonthlyYearly
          ? 'Model confidence note: mixed W/M/Y GFS with Archive can overestimate capacity versus the Veeam Calculator; treat as directional.'
          : 'Model confidence note: Archive + GFS can overestimate capacity versus the Veeam Calculator; treat as directional.'
      );
    }

    const tierUsage = sim.getSOBRTierUsage(repo.id);
    const perfWorkingSpaceTB = workingSpaceByRepo[repo.id]?.byTierAdditional.Performance ?? 0;
    const perfFreeTB = Math.max(0, (repo.sobrConfig.performanceCapacityTB || 0) - (tierUsage.Performance || 0));
    if (perfWorkingSpaceTB > 0 && perfFreeTB + 0.000001 < perfWorkingSpaceTB) {
      const largestFullTB = workingSpaceByRepo[repo.id]?.largestFullTB ?? 0;
      const totalNeededTB = workingSpaceByRepo[repo.id]?.byTier.Performance ?? perfWorkingSpaceTB;
      items.push({
        id: 'INS-008',
        priority: 'high',
        finding: 'Performance tier free headroom is below required temporary workspace.',
        impact: 'Synthetic/full operations can stall or force emergency capacity increases.',
        evidence: `Free headroom ${perfFreeTB.toFixed(2)} TB < required temporary space ${perfWorkingSpaceTB.toFixed(2)} TB (working-space total ${totalNeededTB.toFixed(2)} TB).`,
        recommendation: `Increase Performance capacity or reduce full/retention pressure. Largest full is ${largestFullTB.toFixed(2)} TB.`,
      });
    }

    if (copyEnabled && moveEnabled) {
      items.push({
        id: 'INS-010',
        priority: 'low',
        finding: 'Copy and Move are both enabled, creating dual residency periods.',
        impact: 'Tier overlap can increase storage spend without proportional restore benefit.',
        evidence: `Copy is enabled and move offload starts at ${offloadDays}d.`,
        recommendation: 'Use Move-only for cost efficiency unless copy-driven redundancy is required.',
      });
    }

    const zeroImmutabilityTiers: string[] = [];
    if (performanceImmutabilityDays === 0) zeroImmutabilityTiers.push('Performance');
    if (capacityImmutabilityDays === 0) zeroImmutabilityTiers.push('Capacity');
    if (hasArchiveTier && archiveImmutabilityDays === 0) zeroImmutabilityTiers.push('Archive');
    if (zeroImmutabilityTiers.length > 0) {
      items.push({
        id: 'INS-011',
        priority: 'medium',
        finding: 'Immutability protection is disabled on one or more tiers.',
        impact: 'Reduced ransomware and compliance resilience for affected tier data.',
        evidence: `Zero-day immutability on: ${zeroImmutabilityTiers.join(', ')}.`,
        recommendation: 'Set tier-specific immutability windows aligned with recovery and compliance requirements.',
      });
    }

    if (offloadedInactiveCount > 0) {
      contextNotes.push(`${offloadedInactiveCount} inactive chain(s) beyond ${offloadDays}d already offloaded from Performance.`);
    }
    if (moveEnabled && eligibleButNotYetOffloaded > 0) {
      contextNotes.push(`${eligibleButNotYetOffloaded} inactive chain(s) are below offload age and not yet eligible for movement.`);
    }

    if (items.length === 0) {
      items.push({
        id: 'INS-009',
        priority: 'info',
        finding: 'No active risks detected for current policy.',
        impact: 'Current capacity, offload, and retention settings are operating within thresholds.',
        evidence: `Retention ${retentionDays}d, Offload ${offloadDays}d, overdue inactive chains ${overdueInactiveCount}.`,
      });
    }

    const highestPriority = getHighestPriority(items);
    const title = highestPriority === 'high' || highestPriority === 'medium' || highestPriority === 'low'
      ? 'Policy risks detected in current configuration.'
      : 'No active risks detected for current policy.';

    return {
      title,
      offloadDays,
      retentionDays,
      oldestInactiveDays,
      items,
      contextNotes,
      highestPriority,
    };
  }, [sim.state.repositories, sim.state.jobs, sim.state.chains, currentDate, restorePoints, sim, workingSpaceByRepo, temporarySpacePlanningItems]);

  const hasSobrRepo = sim.state.repositories.some(r => r.type === 'SOBR' && !!r.sobrConfig);
  const bodyAlignmentOffset = (showChainTimeline || showRestoreCatalog || showTierContents) ? '2.1rem' : '0';
  const policyVisual = policyInsight
    ? policyInsight.highestPriority === 'high'
      ? {
          border: '#f7c7c3',
          panelBg: 'linear-gradient(180deg, #fff8f7 0%, #fff2f1 100%)',
          shadow: '0 10px 24px rgba(180, 35, 24, 0.10)',
          accent: '#d92d20',
          titleColor: '#b42318',
        }
      : policyInsight.highestPriority === 'medium'
        ? {
            border: '#f5d4a0',
            panelBg: 'linear-gradient(180deg, #fffaf2 0%, #fff7ec 100%)',
            shadow: '0 10px 24px rgba(181, 71, 8, 0.10)',
            accent: '#f79009',
            titleColor: '#9a4d00',
          }
        : policyInsight.highestPriority === 'low'
          ? {
              border: '#c9ddf7',
              panelBg: 'linear-gradient(180deg, #f7fbff 0%, #eff6ff 100%)',
              shadow: '0 10px 24px rgba(25, 118, 210, 0.10)',
              accent: '#1976d2',
              titleColor: '#1e5ea8',
            }
          : {
              border: '#dde3e8',
              panelBg: 'linear-gradient(180deg, #fbfcfd 0%, #f5f7f9 100%)',
              shadow: '0 8px 20px rgba(69, 90, 100, 0.08)',
              accent: '#78909c',
              titleColor: '#546e7a',
            }
    : null;

  const itemPriorityStyle: Record<InsightPriority, { bg: string; fg: string; border: string; label: string }> = {
    high: { bg: '#fce8e6', fg: '#b42318', border: '#f7c7c3', label: 'High' },
    medium: { bg: '#fff4dd', fg: '#9a4d00', border: '#f5d4a0', label: 'Medium' },
    low: { bg: '#e8f1fd', fg: '#1e5ea8', border: '#c9ddf7', label: 'Low' },
    info: { bg: '#eceff1', fg: '#455a64', border: '#d8dee3', label: 'Info' },
  };

  const typeColors: Record<string, string> = {
    Full: '#1e6bb8',
    Incremental: '#2e7d32',
    SyntheticFull: '#6a1b9a',
  };

  return (
    <div>
      <div className="output-panel-header">
        <h2 style={{ margin: 0 }}>Simulation Output</h2>
      </div>

      {/* Storage Usage per Repository + Summary Stats */}
      <h3 style={{ marginTop: 0, marginBottom: '0.4rem' }}>Repository Storage Usage</h3>
      {hasGenerationUi && <StateLegend />}
      <div style={{ display: 'flex', gap: '1.2rem', alignItems: 'stretch', flexWrap: 'nowrap', marginBottom: '1.2rem' }}>
        <div style={{ flex: '1 1 0', minWidth: 0, overflowX: 'hidden', border: '1px solid #d9e3ea', borderRadius: '10px', background: 'linear-gradient(180deg, #ffffff 0%, #f8fbfd 100%)', padding: '0.85rem', boxShadow: '0 6px 18px rgba(44, 62, 80, 0.08)', display: 'flex', flexDirection: 'column' }}>
          <table className="storage-table" style={{ flex: '1 1 auto' }}>
        <thead>
          <tr>
            <th>Repository</th>
            <th>Type</th>
            <th>Used</th>
            <th>Work Space</th>
            {hasGenerationUi && <th>GENs</th>}
            {hasGenerationUi && <th>Next Delete</th>}
            <th>Capacity</th>
            <th>Usage %</th>
          </tr>
        </thead>
        <tbody>
          {sim.state.repositories.map(repo => {
            const used = storageUsage[repo.id] || 0;
            const neededWorkingSpaceTB = workingSpaceByRepo[repo.id]?.totalTB ?? 0;
            const largestFullTB = workingSpaceByRepo[repo.id]?.largestFullTB ?? 0;
            const additionalWorkingSpaceTB = workingSpaceByRepo[repo.id]?.additionalTB ?? 0;
            const initialSourceTB = workingSpaceByRepo[repo.id]?.initialSourceTB ?? 0;
            const pct = repo.capacityTB > 0 ? (used / repo.capacityTB) * 100 : 0;
            const isSobr = repo.type === 'SOBR' && repo.sobrConfig;
            const tierUsage = isSobr ? sim.getSOBRTierUsage(repo.id) : null;
            const tierColors: Record<string, string> = { Performance: '#1976d2', Capacity: '#388e3c', Archive: '#7b1fa2' };
            const repoJobIds = sim.state.jobs.filter(j => j.repositoryId === repo.id).map(j => j.id);
            const repoGenerations = generationSnapshots.filter(g => repoJobIds.includes(g.jobId));
            const repoLockedGenerations = repoGenerations.filter(g => g.lifecycleState === 'DeleteOn Pending').length;
            const repoWaitingGenerations = repoGenerations.filter(g => g.lifecycleState === 'Waiting Immutability').length;
            const repoDeletableGenerations = repoGenerations.filter(g => g.lifecycleState === 'Deletable').length;
            const repoNextDeleteOn = repoGenerations.map(g => g.deleteOn).sort()[0];
            return (
              <React.Fragment key={repo.id}>
                <tr>
                  <td>{repo.name}</td>
                  <td>{repo.type}</td>
                  <td>{formatTB(used)}</td>
                  <td title={`${formatTB(additionalWorkingSpaceTB)} (tiered scale on ${formatTB(initialSourceTB)} initial source)`}>{formatTB(neededWorkingSpaceTB)}</td>
                  {hasGenerationUi && <td>{renderGenTotals(repoLockedGenerations, repoWaitingGenerations, repoDeletableGenerations)}</td>}
                  {hasGenerationUi && <td>{repoNextDeleteOn || '-'}</td>}
                  <td>{formatTB(repo.capacityTB)}</td>
                  <td>
                    <div style={{ background: '#e0e0e0', borderRadius: '3px', height: '12px', width: '68px', display: 'inline-block', verticalAlign: 'middle' }}>
                      <div style={{ background: pct > 100 ? '#7b1fa2' : pct > 85 ? '#d32f2f' : '#1976d2', width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: '3px' }} />
                    </div>
                    {' '}<span style={{ color: pct > 100 ? '#7b1fa2' : pct > 85 ? '#d32f2f' : undefined, fontWeight: pct > 100 ? 'bold' : undefined }}>{pct.toFixed(1)}%</span>
                  </td>
                </tr>
                {isSobr && repo.sobrConfig && ['Performance', 'Capacity', ...(repo.sobrConfig.hasArchiveTier ? ['Archive'] : [])].map(tier => {
                  const tierUsed = tierUsage?.[tier] ?? 0;
                  const tierWorkingSpaceNeededTB = workingSpaceByRepo[repo.id]?.byTier[tier as 'Performance' | 'Capacity' | 'Archive'] ?? 0;
                  const tierWorkingSpaceAdditionalTB = workingSpaceByRepo[repo.id]?.byTierAdditional[tier as 'Performance' | 'Capacity' | 'Archive'] ?? 0;
                  const tierCap = tier === 'Performance' ? repo.sobrConfig!.performanceCapacityTB
                    : tier === 'Capacity' ? repo.sobrConfig!.capacityCapacityTB
                    : repo.sobrConfig!.archiveCapacityTB;
                  const tierPct = tierCap > 0 ? (tierUsed / tierCap) * 100 : 0;
                  return (
                    <tr key={tier} style={{ background: '#f9f9f9', fontSize: '0.85rem' }}>
                      <td style={{ paddingLeft: '1.5rem', color: tierColors[tier], fontWeight: 'bold' }}>↳ {tier}</td>
                      <td style={{ color: '#999' }}>SOBR Tier</td>
                      <td>{formatTB(tierUsed)}</td>
                      <td title={tier === 'Performance' ? `${formatTB(tierWorkingSpaceAdditionalTB)} (tiered scale on ${formatTB(initialSourceTB)} initial source)` : 'No working-space requirement on this tier'}>{formatTB(tierWorkingSpaceNeededTB)}</td>
                      {hasGenerationUi && <td>{renderGenTotals(
                        repoGenerations.filter(g => {
                          const inTier = tier === 'Performance' ? g.hasPerformanceData : tier === 'Capacity' ? g.hasCapacityData : g.hasArchiveData;
                          return inTier && g.lifecycleState === 'DeleteOn Pending';
                        }).length,
                        repoGenerations.filter(g => {
                          const inTier = tier === 'Performance' ? g.hasPerformanceData : tier === 'Capacity' ? g.hasCapacityData : g.hasArchiveData;
                          return inTier && g.lifecycleState === 'Waiting Immutability';
                        }).length,
                        repoGenerations.filter(g => {
                          const inTier = tier === 'Performance' ? g.hasPerformanceData : tier === 'Capacity' ? g.hasCapacityData : g.hasArchiveData;
                          return inTier && g.lifecycleState === 'Deletable';
                        }).length
                      )}</td>}
                      {hasGenerationUi && <td>-</td>}
                      <td>{formatTB(tierCap)}</td>
                      <td>
                        <div style={{ background: '#e0e0e0', borderRadius: '3px', height: '9px', width: '58px', display: 'inline-block', verticalAlign: 'middle' }}>
                          <div style={{ background: tierPct > 100 ? '#7b1fa2' : tierPct > 85 ? '#d32f2f' : tierColors[tier], width: `${Math.min(100, tierPct)}%`, height: '100%', borderRadius: '3px' }} />
                        </div>
                        {' '}<span style={{ color: tierPct > 100 ? '#7b1fa2' : tierPct > 85 ? '#d32f2f' : undefined, fontWeight: tierPct > 100 ? 'bold' : undefined }}>{tierPct.toFixed(1)}%</span>
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            );
          })}
        </tbody>
          </table>
        </div>

        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.85rem', border: '1px solid #d9e3ea', borderRadius: '10px', background: 'linear-gradient(180deg, #ffffff 0%, #f8fbfd 100%)', padding: '0.85rem', boxShadow: '0 6px 18px rgba(44, 62, 80, 0.08)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.8rem', alignItems: 'stretch' }}>
            <div style={{ background: '#e3f2fd', borderRadius: '10px', padding: '10px 16px', minWidth: '140px', border: '1px solid #d5e8f7', boxShadow: '0 6px 16px rgba(30, 107, 184, 0.10)' }}>
              <div style={{ fontSize: '0.8rem', color: '#555' }}>Total Restore Points</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{restorePoints.length}</div>
            </div>
            <div style={{ background: '#e8f5e9', borderRadius: '10px', padding: '10px 16px', minWidth: '140px', border: '1px solid #d6ead8', boxShadow: '0 6px 16px rgba(56, 142, 60, 0.10)' }}>
              <div style={{ fontSize: '0.8rem', color: '#555' }}>Total Used Storage</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{formatTB(totalUsedTB)}</div>
            </div>
            <div style={{ background: '#fff8e1', borderRadius: '10px', padding: '10px 16px', minWidth: '140px', border: '1px solid #f5e4b6', boxShadow: '0 6px 16px rgba(186, 137, 0, 0.10)' }}>
              <div style={{ fontSize: '0.8rem', color: '#555' }}>Working Space Needed</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{formatTB(totalWorkingSpaceTB)}</div>
            </div>
            <div style={{ background: '#f3e5f5', borderRadius: '10px', padding: '10px 16px', minWidth: '140px', border: '1px solid #ead9ef', boxShadow: '0 6px 16px rgba(122, 31, 162, 0.10)' }}>
              <div style={{ fontSize: '0.8rem', color: '#555' }}>Active Chains</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{activeChains}</div>
            </div>
            <div style={{ background: '#fce4ec', borderRadius: '10px', padding: '10px 16px', minWidth: '140px', border: '1px solid #f4d5df', boxShadow: '0 6px 16px rgba(194, 24, 91, 0.10)' }}>
              <div style={{ fontSize: '0.8rem', color: '#555' }}>GFS Points</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{gfsCount}</div>
            </div>
            {hasGenerationUi && (
              <>
                <div style={{ background: '#e8eaf6', borderRadius: '10px', padding: '10px 16px', minWidth: '140px', border: '1px solid #d6dbf5', boxShadow: '0 6px 16px rgba(63, 81, 181, 0.10)' }}>
                  <div style={{ fontSize: '0.8rem', color: '#555' }}>Total GENs</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{genSummary.total}</div>
                </div>
                <div style={{ background: '#efebe9', borderRadius: '10px', padding: '10px 16px', minWidth: '140px', border: '1px solid #ddd6d2', boxShadow: '0 6px 16px rgba(93, 64, 55, 0.10)' }}>
                  <div style={{ fontSize: '0.8rem', color: '#555' }}>Locked GENs</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{genSummary.locked}</div>
                </div>
                <div style={{ background: '#e8f5e9', borderRadius: '10px', padding: '10px 16px', minWidth: '140px', border: '1px solid #d6ead8', boxShadow: '0 6px 16px rgba(46, 125, 50, 0.10)' }}>
                  <div style={{ fontSize: '0.8rem', color: '#555' }}>Deletable GENs</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>{genSummary.deletable}</div>
                </div>
              </>
            )}
          </div>

          {policyInsight ? (
            <div style={{ border: `1px solid ${policyVisual!.border}`, borderRadius: '14px', background: policyVisual!.panelBg, padding: '0.95rem 1rem', minWidth: '320px', boxShadow: policyVisual!.shadow, borderLeft: `6px solid ${policyVisual!.accent}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                <div style={{ fontSize: '0.74rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: policyVisual!.titleColor }}>
                  Policy Insight
                </div>
                <span style={{
                  marginLeft: 'auto',
                  borderRadius: '999px',
                  border: `1px solid ${itemPriorityStyle[policyInsight.highestPriority].border}`,
                  background: itemPriorityStyle[policyInsight.highestPriority].bg,
                  color: itemPriorityStyle[policyInsight.highestPriority].fg,
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  padding: '2px 8px',
                }}>
                  {itemPriorityStyle[policyInsight.highestPriority].label}
                </span>
              </div>
              <div style={{ fontSize: '0.92rem', color: '#37474f', marginBottom: '0.45rem', lineHeight: '1.45' }}>
                {policyInsight.title}
              </div>
              <div style={{ fontSize: '0.8rem', color: '#607d8b', marginBottom: '0.35rem', fontWeight: 600 }}>
                {immutabilitySummary}
              </div>
              {hasSobrRepo && (
                <div style={{ marginBottom: '0.35rem' }}>
                  <StateLegend />
                </div>
              )}
              {hasSobrRepo && (
                <>
                  <div style={{ fontSize: '0.82rem', color: '#607d8b', marginBottom: '0.25rem', fontWeight: 600 }}>
                    Retention: {policyInsight.retentionDays}d | Offload: {policyInsight.offloadDays}d | Oldest inactive chain: {policyInsight.oldestInactiveDays}d
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#607d8b', marginBottom: '0.45rem' }}>
                    GENs: {genSummary.total} total, {genSummary.locked} locked, {genSummary.deletable} deletable
                    {genSummary.nextDeleteOn ? ` | Next DeleteOn: ${genSummary.nextDeleteOn}` : ''}
                    {genSummary.nextImmutabilityExpiry ? ` | Next immutability expiry: ${genSummary.nextImmutabilityExpiry}` : ''}
                  </div>
                </>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {policyInsight.items.map(item => (
                  <div key={item.id} style={{ border: `1px solid ${itemPriorityStyle[item.priority].border}`, borderRadius: '9px', background: '#fff', padding: '0.5rem 0.6rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                      <span style={{
                        borderRadius: '999px',
                        border: `1px solid ${itemPriorityStyle[item.priority].border}`,
                        background: itemPriorityStyle[item.priority].bg,
                        color: itemPriorityStyle[item.priority].fg,
                        fontSize: '0.68rem',
                        fontWeight: 700,
                        padding: '1px 7px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}>
                        {itemPriorityStyle[item.priority].label}
                      </span>
                      <span style={{ fontSize: '0.83rem', fontWeight: 700, color: '#37474f' }}>{item.finding}</span>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#546e7a', marginBottom: '0.15rem' }}><strong>Impact:</strong> {item.impact}</div>
                    <div style={{ fontSize: '0.78rem', color: '#546e7a', marginBottom: item.recommendation ? '0.15rem' : 0 }}><strong>Evidence:</strong> {item.evidence}</div>
                    {item.recommendation && (
                      <div style={{ fontSize: '0.78rem', color: '#455a64' }}><strong>Recommendation:</strong> {item.recommendation}</div>
                    )}
                  </div>
                ))}
              </div>
              {policyInsight.contextNotes.length > 0 && (
                <div style={{ marginTop: '0.4rem', fontSize: '0.79rem', color: '#78909c' }}>
                  {policyInsight.contextNotes.map((note, idx) => (
                    <div key={idx}>Context: {note}</div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Section toggle buttons */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
        <button
          onClick={() => setShowChainTimeline(v => !v)}
          style={{ padding: '6px 10px', fontWeight: 'bold', cursor: 'pointer' }}
        >
          {showChainTimeline ? '▼' : '▶'} Chain Timeline
        </button>
        <button
          onClick={() => setShowRestoreCatalog(v => !v)}
          style={{ padding: '6px 10px', fontWeight: 'bold', cursor: 'pointer' }}
        >
          {showRestoreCatalog ? '▼' : '▶'} Restore Point Catalog ({restorePoints.length} restore points)
        </button>
        <button
          onClick={() => setShowTierContents(v => !v)}
          style={{ padding: '6px 10px', fontWeight: 'bold', cursor: 'pointer' }}
        >
          {showTierContents ? '▼' : '▶'} Tier Contents (Current Placement)
        </button>
      </div>

      {/* Simulation advance + year-jump controls */}
      <div style={{ position: 'sticky', top: 0, zIndex: 3, marginBottom: '0.55rem' }}>
        <div style={{
          display: 'flex',
          gap: '0.45rem',
          flexWrap: 'wrap',
          alignItems: 'center',
          background: 'linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)',
          border: '1px solid #d9e6f2',
          borderRadius: '10px',
          padding: '0.45rem 0.5rem',
          boxShadow: '0 8px 20px rgba(25, 118, 210, 0.10)'
        }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.45rem',
            borderRadius: '999px',
            background: '#e3f2fd',
            border: '1px solid #90caf9',
            color: '#0d47a1',
            fontSize: '0.88rem',
            fontWeight: 700,
            marginRight: '0.25rem',
            padding: '4px 11px'
          }}>
            <span style={{ letterSpacing: '0.03em' }}>Simulation Date</span>
            <strong>{simDateMeta.isoDate}</strong>
            <span style={{
              borderRadius: '999px',
              padding: '1px 7px',
              border: `1px solid ${simDateMeta.isWeekend ? '#ffd08a' : '#b3d4fc'}`,
              background: simDateMeta.isWeekend ? '#fff3e0' : '#eaf3ff',
              color: simDateMeta.isWeekend ? '#b65d00' : '#1565c0',
              fontWeight: 700,
              fontSize: '0.76rem'
            }}>
              {simDateMeta.weekday}
            </span>
            <span style={{ color: '#455a64', fontWeight: 600, fontSize: '0.75rem' }}>Day +{simDateMeta.elapsedDays}</span>
          </span>
          <span style={{ color: '#d0d0d0', margin: '0 0.2rem', userSelect: 'none' }}>│</span>
        {([1, 7, 30] as const).map(days => (
          <button
            key={days}
            onClick={() => { setActivityLogFilter(null); onNextDay(days); }}
            style={{
              padding: '3px 13px',
              borderRadius: '999px',
              border: '1px solid #90caf9',
              background: '#e3f2fd',
              color: '#1565c0',
              fontWeight: 700,
              fontSize: '0.81rem',
              cursor: 'pointer',
              lineHeight: '1.6',
            }}
          >
            ▶ +{days} Day{days > 1 ? 's' : ''}
          </button>
        ))}
        <span style={{ color: '#d0d0d0', margin: '0 0.2rem', userSelect: 'none' }}>│</span>
        {([1, 2, 3] as const).map(yr => {
          const daysLeft = computeDaysToYear(yr);
          const disabled = daysLeft <= 0;
          return (
            <button
              key={yr}
              disabled={disabled}
              title={disabled ? `Already at or past Year ${yr}` : `Jump to Year ${yr} (${daysLeft} days from now)`}
              onClick={() => { setActivityLogFilter(30); onNextDay(daysLeft); }}
              style={{
                padding: '3px 13px',
                borderRadius: '999px',
                border: `1px solid ${disabled ? '#e0e0e0' : '#ffcc80'}`,
                background: disabled ? '#f5f5f5' : '#fff3e0',
                color: disabled ? '#bbb' : '#bf360c',
                fontWeight: 700,
                fontSize: '0.81rem',
                cursor: disabled ? 'not-allowed' : 'pointer',
                lineHeight: '1.6',
                opacity: disabled ? 0.55 : 1,
              }}
            >
              ⏩ Year {yr}
            </button>
          );
        })}
        {activityLogFilter !== null && (
          <span style={{ fontSize: '0.76rem', color: '#bf360c', fontStyle: 'italic', marginLeft: '0.3rem' }}>
            Activity Log: last {activityLogFilter} days only
          </span>
        )}
      </div>
      </div>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 820px', minWidth: '340px' }}>
      {/* Chain Timeline */}
      {showChainTimeline && <ChainTimeline sim={sim} currentDate={currentDate} onSelectRestorePoint={setSelectedRestorePointId} />}

      {/* Restore Point Catalog */}
      {showRestoreCatalog && (
      <>
      <h3 style={{ marginTop: 0, marginBottom: '0.4rem' }}>Restore Point Catalog</h3>
      {hasGenerationUi && <StateLegend />}
      <table border={1} cellPadding={6} className="backup-table" style={{ borderCollapse: 'collapse', width: '100%', marginBottom: '1rem' }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <th>RP ID</th>
            <th>Created</th>
            <th>Type</th>
            <th>Role</th>
            <th>Chain State</th>
            <th>Immutability</th>
            <th>Represents</th>
            <th>Current Tier</th>
            <th>Size (TB)</th>
          </tr>
        </thead>
        <tbody>
          {sortedRestorePoints.map((rp) => {
            const isSelected = selectedRestorePointId === rp.id;
            const isSobr = !!rp.sobrTier || !!rp.hasPerformanceData || !!rp.hasCapacityData || !!rp.hasArchiveData;
            const currentTier = (rp.sobrTier || 'Performance') as 'Performance' | 'Capacity' | 'Archive';
            const isGlobalBase = !!rp.isGlobalBase;
            const isTierBase = isGlobalBase || (rp.baseTiers || []).includes(currentTier);
            const role = isTierBase ? 'Base Full' : (rp.isGFS ? 'GFS' : 'Daily');
            const displayType = rp.type;
            const displaySizeTB = sim.getRestorePointSizeForTier(rp.id, currentTier);
            const tierColor: Record<string, string> = { Performance: '#1976d2', Capacity: '#388e3c', Archive: '#7b1fa2' };
            const chain = chainById[rp.chainId];
            return (
              <tr
                key={rp.id}
                onClick={() => setSelectedRestorePointId(rp.id)}
                style={{
                  background: isSelected ? '#e3f2fd' : (rp.isGFS ? '#fff9c4' : undefined),
                  cursor: 'pointer',
                }}
              >
                <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{shortId(rp.id)}</td>
                <td>{rp.date}</td>
                <td>
                  <span style={{ color: typeColors[rp.type] || '#333', fontWeight: 'bold', fontSize: '0.9rem' }}>
                    {displayType}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', alignItems: 'center' }}>
                    {isTierBase && (
                      <span style={{ background: '#455a64', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                        Base Full
                      </span>
                    )}
                    {!isTierBase && !rp.isGFS && (
                      <span style={{ background: '#546e7a', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                        Daily
                      </span>
                    )}
                    {rp.isWeeklyGFS && (
                      <span style={{ background: '#1565c0', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>W</span>
                    )}
                    {rp.isMonthlyGFS && (
                      <span style={{ background: '#6a1b9a', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>M</span>
                    )}
                    {rp.isYearlyGFS && (
                      <span style={{ background: '#b71c1c', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>Y</span>
                    )}
                  </div>
                </td>
                <td style={{ fontSize: '0.8rem' }}>
                  {chain ? (
                    <>
                      <div style={{ fontWeight: 'bold', color: chain.status === 'Inactive' ? '#b26a00' : '#2e7d32' }}>{chain.status}</div>
                      {chain.inactiveSince && <div style={{ color: '#666' }}>since {chain.inactiveSince}</div>}
                    </>
                  ) : (
                    <span style={{ color: '#666' }}>Preserved / Detached</span>
                  )}
                </td>
                <td>{renderImmutabilityChip(rp, currentTier)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                  {rp.representsRestorePointDate ? `${rp.representsRestorePointDate} / ${shortId(rp.representsRestorePointId || '')}` : `${rp.date} / self`}
                </td>
                <td style={{ textAlign: 'center' }}>
                  {isSobr ? (
                    <span style={{ background: tierColor[rp.sobrTier || 'Performance'] ?? '#888', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem' }}>
                      {rp.sobrTier}
                    </span>
                  ) : '-'}
                </td>
                <td>{formatTB(displaySizeTB)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </>
      )}

      {/* Tier Contents */}
      {showTierContents && (
      <>
      <h3 style={{ marginTop: 0, marginBottom: '0.4rem' }}>
        {isPrimaryRepoSobr ? 'Tier Contents' : 'Primary Storage Contents'}
      </h3>
      {hasGenerationUi && <StateLegend />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.8rem', marginBottom: '0.8rem' }}>
        {visibleTierOrder.map((tier) => {
          const tierColor: Record<string, string> = { Performance: '#1976d2', Capacity: '#388e3c', Archive: '#7b1fa2' };
          const list = tierBuckets[tier];
          const tierLabel = !isPrimaryRepoSobr && tier === 'Performance' ? 'Primary Storage' : tier;
          return (
            <div key={tier} style={{ border: `1px solid ${tierColor[tier]}`, borderRadius: '6px', overflow: 'hidden' }}>
              <div style={{ background: tierColor[tier], color: '#fff', padding: '6px 10px', fontWeight: 'bold', fontSize: '0.9rem' }}>
                {tierLabel} ({list.length})
              </div>
              <div style={{ background: '#fafafa' }}>
                {list.length === 0 ? (
                  <div style={{ padding: '8px 10px', color: '#777', fontSize: '0.85rem' }}>No restore points currently in this tier.</div>
                ) : (
                  list.map((rp) => {
                    const isSelected = selectedRestorePointId === rp.id;
                    const isGlobalBase = !!rp.isGlobalBase;
                    const isTierBase = isGlobalBase || (rp.baseTiers || []).includes(tier);
                    const displayType = rp.type;
                    const displaySizeTB = sim.getRestorePointSizeForTier(rp.id, tier);
                    const prunedFromCapacity = tier === 'Performance' && wasPrunedFromCapacity(rp);
                    return (
                      <button
                        key={`${tier}-${rp.id}`}
                        onClick={() => setSelectedRestorePointId(rp.id)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          border: 'none',
                          borderBottom: '1px solid #eceff1',
                          background: isSelected ? '#e3f2fd' : '#fff',
                          padding: '7px 10px',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center' }}>
                          <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: '#455a64' }}>{shortId(rp.id)}</span>
                          <span style={{ fontSize: '0.8rem', color: '#607d8b' }}>{rp.date}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center', marginTop: '2px' }}>
                          <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: '#37474f' }}>{displayType}{isTierBase ? ' (Base)' : ''}</span>
                          <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{formatTB(displaySizeTB)}</span>
                        </div>
                        {renderGenMetadataLine(rp)}
                        <div style={{ display: 'flex', gap: '3px', marginTop: '3px', flexWrap: 'wrap' }}>
                          {renderImmutabilityChip(rp, tier)}
                          {prunedFromCapacity && (
                            <span style={{ background: '#8d6e63', color: '#fff', borderRadius: '3px', padding: '0px 5px', fontSize: '0.7rem', fontWeight: 'bold' }}>
                              Pruned
                            </span>
                          )}
                          {rp.isWeeklyGFS && <span style={{ background: '#1565c0', color: '#fff', borderRadius: '3px', padding: '0px 5px', fontSize: '0.7rem', fontWeight: 'bold' }}>W</span>}
                          {rp.isMonthlyGFS && <span style={{ background: '#6a1b9a', color: '#fff', borderRadius: '3px', padding: '0px 5px', fontSize: '0.7rem', fontWeight: 'bold' }}>M</span>}
                          {rp.isYearlyGFS && <span style={{ background: '#b71c1c', color: '#fff', borderRadius: '3px', padding: '0px 5px', fontSize: '0.7rem', fontWeight: 'bold' }}>Y</span>}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
      </>
      )}
        </div>

        <div style={{ flex: '0 1 360px', minWidth: '300px', alignSelf: 'flex-start', marginTop: bodyAlignmentOffset }}>
          <div style={{ border: '1px solid #f9a825', borderRadius: '6px', background: '#fffde7', padding: '0.7rem 0.9rem', marginBottom: '0.8rem' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '0.4rem' }}>Activity Log</div>
            <div style={{ fontSize: '0.78rem', color: '#795548', marginBottom: '0.45rem' }}>
              Simulation Date: {getSimulationDayLabel(currentDate)}
            </div>
            <div style={{ fontSize: '0.85rem', color: '#5d4037' }}>
              {dailyExplanation
                ? (() => {
                    // Parse activity into per-event items while preserving the source day.
                    // For multi-day jumps, entries are prefixed like: [YYYY-MM-DD] <day activity...>
                    const dayChunkPattern = /(\[\d{4}-\d{2}-\d{2}\][\s\S]*?)(?=\s\[\d{4}-\d{2}-\d{2}\]|$)/g;
                    const chunks = dailyExplanation.match(dayChunkPattern) || [dailyExplanation];
                    const items: string[] = [];
                    for (const chunk of chunks) {
                      const dayMatch = chunk.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*/);
                      const dayPrefix = dayMatch ? `[${dayMatch[1]}] ` : '';
                      const body = chunk.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '');
                      const sentences = body
                        .split('. ')
                        .flatMap(s => s.split('.\u0020'))
                        .map(s => s.trim().replace(/\.$/, ''))
                        .filter(Boolean);

                      for (const sentence of sentences) {
                        items.push(`${dayPrefix}${sentence}`.trim());
                      }
                    }

                    // De-duplicate promotion housekeeping lines.
                    // If both "promoted as" and "set as" exist for the same RP+tier, keep only "set as".
                    const promotionPattern = /^Restore point\s+(\S+)\s+(promoted as|set as)\s+(Performance|Capacity|Archive)\s+base full$/i;
                    const bestPromotionByKey = new Map<string, { text: string; score: number }>();
                    for (const item of items) {
                      const match = item.match(promotionPattern);
                      if (!match) continue;
                      const rpId = match[1];
                      const action = match[2].toLowerCase();
                      const tier = match[3].toLowerCase();
                      const key = `${rpId}|${tier}`;
                      const score = action.includes('set as') ? 2 : 1;
                      const current = bestPromotionByKey.get(key);
                      if (!current || score >= current.score) {
                        bestPromotionByKey.set(key, { text: item, score });
                      }
                    }

                    const seenPromotion = new Set<string>();
                    const displayItems = items.filter(item => {
                      const match = item.match(promotionPattern);
                      if (!match) return true;
                      const key = `${match[1]}|${match[3].toLowerCase()}`;
                      const best = bestPromotionByKey.get(key);
                      if (!best || best.text !== item || seenPromotion.has(key)) return false;
                      seenPromotion.add(key);
                      return true;
                    });

                    // Categorise each item for grouping
                    const categorise = (s: string): { label: string; color: string; bg: string } => {
                      if (/GEN summary|DeleteOn|immutability|generation/i.test(s))
                        return { label: 'GEN', color: '#283593', bg: '#e8eaf6' };
                      if (/pruned .*Capacity point|pruned from Capacity/i.test(s))
                        return { label: 'Prune', color: '#6d4c41', bg: '#efebe9' };
                      if (/copied to Capacity tier.*Copy mode|GFS point.*copied to Capacity/i.test(s))
                        return { label: 'Copy', color: '#00695c', bg: '#e0f2f1' };
                      if (/move finalized|offloaded in full Performance\s*->|GFS point.*offloaded.*Performance/i.test(s))
                        return { label: 'Move', color: '#1565c0', bg: '#e3f2fd' };
                      if (/offloaded.*Capacity.*Archive|Capacity\s*->|GFS point.*offloaded.*Capacity/i.test(s))
                        return { label: 'Tier Move', color: '#1565c0', bg: '#e3f2fd' };
                      if (/tagged as GFS/i.test(s))
                        return { label: 'GFS Tag', color: '#6a1b9a', bg: '#f3e5f5' };
                      if (/GFS.*deleted|exceeds.*GFS limit/i.test(s))
                        return { label: 'GFS Expiry', color: '#b71c1c', bg: '#ffebee' };
                      if (/promoted as|base full|set as.*base/i.test(s))
                        return { label: 'Promotion', color: '#37474f', bg: '#eceff1' };
                      if (/created a.*restore point|SyntheticFull|Full restore/i.test(s))
                        return { label: 'Backup', color: '#1b5e20', bg: '#e8f5e9' };
                      if (/deleted due to retention|Chain.*deleted/i.test(s))
                        return { label: 'Retention', color: '#e65100', bg: '#fff3e0' };
                      return { label: 'Info', color: '#4e342e', bg: '#f5f5f5' };
                    };

                    type GroupedActivity = { day: string; text: string };
                    const dayPrefixPattern = /^\[(\d{4}-\d{2}-\d{2})\]\s*/;
                    const grouped = new Map<string, GroupedActivity[]>();

                    for (const item of displayItems) {
                      const prefixMatch = item.match(dayPrefixPattern);
                      const day = prefixMatch?.[1] || currentDate;
                      const text = item.replace(dayPrefixPattern, '').trim();
                      const list = grouped.get(day) || [];
                      list.push({ day, text });
                      grouped.set(day, list);
                    }

                    if (hasGenerationUi) {
                      const genList = grouped.get(currentDate) || [];
                      genList.unshift({
                        day: currentDate,
                        text: `GEN summary: ${genSummary.total} total, ${genSummary.locked} locked, ${genSummary.deletable} deletable${genSummary.nextDeleteOn ? `, next DeleteOn ${genSummary.nextDeleteOn}` : ''}`,
                      });
                      grouped.set(currentDate, genList);
                    }

                    const groupedDays = Array.from(grouped.keys()).sort((a, b) => b.localeCompare(a));

                    const cutoffDate = activityLogFilter !== null
                      ? (() => {
                          const d = new Date(`${currentDate}T00:00:00.000Z`);
                          d.setUTCDate(d.getUTCDate() - activityLogFilter + 1);
                          return d.toISOString().slice(0, 10);
                        })()
                      : null;
                    const filteredGroupedDays = cutoffDate
                      ? groupedDays.filter(day => day >= cutoffDate)
                      : groupedDays;
                    const hiddenDayCount = groupedDays.length - filteredGroupedDays.length;

                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', maxHeight: '350px', overflowY: 'auto', paddingRight: '0.2rem' }}>
                        {hiddenDayCount > 0 && (
                          <div style={{ fontSize: '0.74rem', color: '#888', fontStyle: 'italic', padding: '0.2rem 0.35rem', borderRadius: '4px', background: '#f5f5f5' }}>
                            {hiddenDayCount} earlier day{hiddenDayCount > 1 ? 's' : ''} hidden — showing last {activityLogFilter} days only.{' '}
                            <span
                              style={{ color: '#1565c0', cursor: 'pointer', textDecoration: 'underline' }}
                              onClick={() => setActivityLogFilter(null)}
                            >Show all</span>
                          </div>
                        )}
                        {filteredGroupedDays.map((day) => {
                          const dayItems = grouped.get(day) || [];
                          const summaryCounts = new Map<string, number>();
                          for (const entry of dayItems) {
                            const label = categorise(entry.text).label;
                            summaryCounts.set(label, (summaryCounts.get(label) || 0) + 1);
                          }
                          const summaryText = Array.from(summaryCounts.entries())
                            .map(([label, count]) => `${count} ${label}`)
                            .join(', ');

                          return (
                            <details key={day} open={day === currentDate} style={{ border: '1px solid #f0d6a8', borderRadius: '6px', background: '#fffef8' }}>
                              <summary style={{ cursor: 'pointer', listStyle: 'none', fontSize: '0.74rem', fontWeight: 700, color: '#6d4c41', padding: '0.34rem 0.5rem' }}>
                                {day === currentDate ? `${day} (current)` : day}
                                <span style={{ fontWeight: 400, marginLeft: '0.5rem' }}>- {summaryText}</span>
                              </summary>
                              <ul style={{ margin: 0, padding: '0 0.35rem 0.35rem', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                {dayItems.map((entry, i) => {
                                  const cat = categorise(entry.text);
                                  return (
                                  <li key={`${day}-${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem', background: cat.bg, borderRadius: '6px', padding: '0.28rem 0.45rem' }}>
                                    <span style={{ fontSize: '0.68rem', fontWeight: 800, color: cat.color, whiteSpace: 'nowrap', marginTop: '0.05rem', minWidth: '54px', letterSpacing: '0.02em' }}>
                                      {cat.label}
                                    </span>
                                    <span style={{ lineHeight: '1.4' }}>{normalizeActivityText(entry.text)}.</span>
                                  </li>
                                );
                                })}
                              </ul>
                            </details>
                          );
                        })}
                      </div>
                    );
                  })()
                : <span style={{ color: '#888' }}>No activity yet. Run +1 Day, +7 Days, or +30 Days to generate activity.</span>}
            </div>

          </div>

          <div style={{ border: '1px solid #cfd8dc', borderRadius: '6px', padding: '0.7rem 0.9rem', background: '#fafcfd' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '0.4rem' }}>Selected Restore Point Info</div>
            {selectedRestorePointId && (() => {
              const selected = sortedRestorePoints.find(rp => rp.id === selectedRestorePointId);
              if (!selected) return <div style={{ fontSize: '0.85rem', color: '#607d8b' }}>Select a restore point from the catalog or tier contents.</div>;

              const selectedChain = chainById[selected.chainId];
              const selectedWasPrunedFromCapacity = wasPrunedFromCapacity(selected);
              const currentTier = (selected.sobrTier || 'Performance') as 'Performance' | 'Capacity' | 'Archive';
              const sizeTB = sim.getRestorePointSizeForTier(selected.id, currentTier);
              const currentDateObj = parseISODate(currentDate);
              const pointDateObj = parseISODate(selected.date);
              const ageDays = Math.floor((currentDateObj.getTime() - pointDateObj.getTime()) / 86400000);

              // Job + SOBR config
              const selJob = sim.state.jobs.find(j => selectedChain ? j.id === selectedChain.jobId : false)
                          ?? sim.state.jobs[0];
              const selRepo = selJob ? sim.state.repositories.find(r => r.id === selJob.repositoryId) : undefined;
              const isSobr = selRepo?.type === 'SOBR' && !!selRepo.sobrConfig;
              const sobrCfg = selRepo?.sobrConfig;
              const retentionDays = selJob?.retention?.restorePoints || 0;

              // --- 1. Tier journey with dwell times ---
              const tierBg: Record<string, string> = { Performance: '#1976d2', Capacity: '#388e3c', Archive: '#7b1fa2' };
              const history = selected.tierMoveHistory || [];
              const journeySteps = history.map((step, idx) => {
                const enteredMs = parseISODate(step.date).getTime();
                const exitMs = idx < history.length - 1 ? parseISODate(history[idx + 1].date).getTime() : currentDateObj.getTime();
                const daysInTier = Math.max(0, Math.floor((exitMs - enteredMs) / 86400000));
                return { tier: step.tier, date: step.date, daysInTier, isCurrent: idx === history.length - 1 };
              });

              // --- 2. Restore dependency ---
              const chainPointsAsc = sortedRestorePoints
                .filter(rp => rp.chainId === selected.chainId)
                .slice()
                .sort((a, b) => a.date.localeCompare(b.date));
              const idxOfSelected = chainPointsAsc.findIndex(rp => rp.id === selected.id);
              let anchorIdx = -1;
              for (let i = idxOfSelected; i >= 0; i--) {
                if (chainPointsAsc[i].type === 'Full' || chainPointsAsc[i].type === 'SyntheticFull') {
                  anchorIdx = i;
                  break;
                }
              }
              let dependencyNote: React.ReactNode;
              if (selected.type === 'Full' || selected.type === 'SyntheticFull') {
                dependencyNote = <>Self-contained — no other restore points required.</>;
              } else if (anchorIdx < 0) {
                dependencyNote = <>Chain anchor not found in current retention window — restore may not be possible.</>;
              } else {
                const anchor = chainPointsAsc[anchorIdx];
                const intermediates = chainPointsAsc.slice(anchorIdx + 1, idxOfSelected + 1);
                dependencyNote = (
                  <>
                    Requires <strong>{anchor.type}</strong> from <span style={{ fontFamily: 'monospace' }}>{anchor.date}</span>
                    {intermediates.length > 0 && (
                      <> + <strong>{intermediates.length}</strong> incremental{intermediates.length > 1 ? 's' : ''} ({intermediates[0].date}{intermediates.length > 1 ? ` – ${intermediates[intermediates.length - 1].date}` : ''})</>
                    )}.
                  </>
                );
              }

              // --- 3. Retention forecast ---
              const gfsLabels = [
                selected.isWeeklyGFS && 'Weekly',
                selected.isMonthlyGFS && 'Monthly',
                selected.isYearlyGFS && 'Yearly',
              ].filter(Boolean).join(' + ');
              let retentionNote: React.ReactNode;
              if (selected.isGFS && gfsLabels) {
                retentionNote = <>Preserved by <strong>{gfsLabels} GFS</strong> — retained until policy is modified.</>;
              } else if (retentionDays > 0) {
                const newestNonGfs = chainPointsAsc
                  .filter(rp => !rp.isGFS)
                  .reduce<RestorePointRow | null>((best, rp) => (!best || rp.date > best.date) ? rp : best, null);
                if (newestNonGfs) {
                  const expiryMs = parseISODate(newestNonGfs.date).getTime() + retentionDays * 86400000;
                  const expiryIso = new Date(expiryMs).toISOString().slice(0, 10);
                  const daysUntil = Math.ceil((expiryMs - currentDateObj.getTime()) / 86400000);
                  if (daysUntil > 0) {
                    retentionNote = <>Expires <strong>{expiryIso}</strong> ({daysUntil}d — when chain's newest point ages past {retentionDays}d retention).</>;
                  } else {
                    retentionNote = <>Retention window has passed — chain will be removed on next retention cycle.</>;
                  }
                } else {
                  retentionNote = <>Retention: {retentionDays}d.</>;
                }
              } else {
                retentionNote = <>No retention policy configured.</>;
              }

              // --- 4. Immutability status ---
              const immutabilityStatus = getRestorePointImmutability(selected, currentTier);
              let immutabilityNote: React.ReactNode = <>Not configured.</>;
              if (immutabilityStatus.isLocked === true) {
                const detail = immutabilityStatus.detail;
                const match = detail.match(/lock until (.+)$/);
                const lockDate = match ? match[1] : immutabilityStatus.detail;
                const lockUntilMs = parseISODate(lockDate).getTime();
                const daysUntilUnlock = Math.ceil((lockUntilMs - currentDateObj.getTime()) / 86400000);
                immutabilityNote = daysUntilUnlock > 0
                  ? <>Locked in <strong>{currentTier}</strong> until <strong>{lockDate}</strong> ({daysUntilUnlock}d remaining).</>
                  : <>Lock in <strong>{currentTier}</strong> expired on <strong>{lockDate}</strong>.</>;
              } else if (immutabilityStatus.isLocked === false) {
                const detail = immutabilityStatus.detail;
                const match = detail.match(/lock expired (.+)$/);
                const lockDate = match ? match[1] : immutabilityStatus.detail;
                immutabilityNote = <>Lock in <strong>{currentTier}</strong> expired on <strong>{lockDate}</strong>.</>;
              } else if (immutabilityStatus.isLocked === null) {
                immutabilityNote = <>{immutabilityStatus.detail}</>;
              }

              // --- 5. Archive eligibility ---
              let archiveNote: React.ReactNode = null;
              if (isSobr && sobrCfg?.hasArchiveTier) {
                const copyEnabled = !!sobrCfg.copyEnabled;
                const offloadDays = sobrCfg.offloadAfterDays || 0;
                const archiveAfterDays = sobrCfg.archiveAfterDays || 0;
                if (selected.hasArchiveData) {
                  archiveNote = <>Currently in Archive tier.</>;
                } else if (!selected.isGFS) {
                  archiveNote = <>Not archive-eligible — no GFS tag (only GFS-tagged points move to Archive).</>;
                } else if (copyEnabled) {
                  const totalNeeded = offloadDays + archiveAfterDays;
                  const daysUntil = totalNeeded - ageDays;
                  if (daysUntil > 0) {
                    const archiveIso = new Date(pointDateObj.getTime() + totalNeeded * 86400000).toISOString().slice(0, 10);
                    archiveNote = <>Archive-eligible on <strong>{archiveIso}</strong> ({daysUntil}d — needs {totalNeeded}d total age: offload {offloadDays}d + archive {archiveAfterDays}d).</>;
                  } else {
                    archiveNote = <>Archive-eligible now (age {ageDays}d ≥ {offloadDays}d offload + {archiveAfterDays}d archive).</>;
                  }
                } else {
                  // Move-only: eligible after archiveAfterDays in Capacity tier
                  const capEnteredIso = selected.capacityMoveFinalizedAt || selected.capacityCopyCreatedAt;
                  if (!capEnteredIso) {
                    const daysUntilCapacity = offloadDays - ageDays;
                    archiveNote = daysUntilCapacity > 0
                      ? <>Not yet in Capacity tier — eligible for offload in {daysUntilCapacity}d, then {archiveAfterDays}d more for Archive.</>
                      : <>Waiting for Capacity move — then {archiveAfterDays}d in Capacity before Archive.</>;
                  } else {
                    const capAgeMs = currentDateObj.getTime() - parseISODate(capEnteredIso).getTime();
                    const capAgeDays = Math.floor(capAgeMs / 86400000);
                    const daysUntilArchive = archiveAfterDays - capAgeDays;
                    if (daysUntilArchive > 0) {
                      const archiveIso = new Date(parseISODate(capEnteredIso).getTime() + archiveAfterDays * 86400000).toISOString().slice(0, 10);
                      archiveNote = <>Archive-eligible on <strong>{archiveIso}</strong> ({daysUntilArchive}d — needs {archiveAfterDays}d in Capacity; currently {capAgeDays}d).</>;
                    } else {
                      archiveNote = <>Archive-eligible now ({capAgeDays}d in Capacity ≥ {archiveAfterDays}d threshold).</>;
                    }
                  }
                }
              }

              // GFS tag badges
              const gfsBadges = (
                <>
                  {selected.isWeeklyGFS && <span style={{ background: '#1565c0', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>W</span>}
                  {selected.isMonthlyGFS && <span style={{ background: '#6a1b9a', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>M</span>}
                  {selected.isYearlyGFS && <span style={{ background: '#b71c1c', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>Y</span>}
                  {selected.isGlobalBase && <span style={{ background: '#455a64', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontSize: '0.75rem', fontWeight: 'bold' }}>Base Full</span>}
                </>
              );

              const infoRow = (label: string, value: React.ReactNode) => (
                <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.84rem', marginBottom: '0.28rem' }}>
                  <span style={{ color: '#78909c', minWidth: '120px', flexShrink: 0 }}>{label}</span>
                  <span style={{ color: '#263238' }}>{value}</span>
                </div>
              );

              return (
                <>
                  {/* Quick-facts header */}
                  <div style={{ marginBottom: '0.55rem' }}>
                    {/* ID line — muted, truncated if needed */}
                    <div style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: '#90a4ae', marginBottom: '0.35rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {normalizeActivityText(selected.id)}
                    </div>
                    {/* All badges on one line — type badge shows present role */}
                    <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'nowrap' }}>
                      <span style={{ background: selected.isGlobalBase ? '#455a64' : ((typeColors as Record<string,string>)[selected.type] || '#546e7a'), color: '#fff', borderRadius: '4px', padding: '2px 9px', fontSize: '0.8rem', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                        {selected.isGlobalBase ? 'Base Full' : selected.type}
                      </span>
                      <span style={{ color: '#b0bec5', fontSize: '0.85rem' }}>in</span>
                      <span style={{ background: tierBg[currentTier] || '#546e7a', color: '#fff', borderRadius: '4px', padding: '2px 9px', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                        {currentTier}
                      </span>
                      {(selected.isWeeklyGFS || selected.isMonthlyGFS || selected.isYearlyGFS) && (
                        <span style={{ color: '#b0bec5', fontSize: '0.85rem' }}>·</span>
                      )}
                      {selected.isWeeklyGFS && <span style={{ background: '#1565c0', color: '#fff', borderRadius: '4px', padding: '2px 8px', fontSize: '0.8rem', fontWeight: 'bold' }}>W</span>}
                      {selected.isMonthlyGFS && <span style={{ background: '#6a1b9a', color: '#fff', borderRadius: '4px', padding: '2px 8px', fontSize: '0.8rem', fontWeight: 'bold' }}>M</span>}
                      {selected.isYearlyGFS && <span style={{ background: '#b71c1c', color: '#fff', borderRadius: '4px', padding: '2px 8px', fontSize: '0.8rem', fontWeight: 'bold' }}>Y</span>}
                    </div>
                  </div>

                  {/* Key facts */}
                  {infoRow('Date', selected.representsRestorePointDate || selected.date)}
                  {infoRow('Age', `${ageDays}d`)}
                  {infoRow('Size in tier', formatTB(sizeTB))}
                  {hasGenerationUi && selected.generationId && generationById[selected.generationId] && infoRow('GEN', shortId(selected.generationId))}
                  {hasGenerationUi && selected.generationId && generationById[selected.generationId] && infoRow('DeleteOn', generationById[selected.generationId].deleteOn)}
                  {hasGenerationUi && selected.generationId && generationById[selected.generationId] && infoRow('GEN state', (() => {
                    const genState = generationById[selected.generationId!].lifecycleState;
                    const style = getGenerationStateStyle(genState);
                    return <span style={{ background: style.bg, color: style.color, borderRadius: '4px', padding: '1px 6px', fontSize: '0.78rem', fontWeight: 700 }}>{getGenerationStateLabel(genState)}</span>;
                  })())}
                  {selected.isGlobalBase && infoRow('Created as', selected.type)}
                  {infoRow('Chain', selectedChain
                    ? <><strong style={{ color: selectedChain.status === 'Inactive' ? '#b26a00' : '#2e7d32' }}>{selectedChain.status}</strong>{selectedChain.inactiveSince ? ` since ${selectedChain.inactiveSince}` : ''}</>
                    : 'Detached (GFS orphan)')}

                  <div style={{ borderTop: '1px solid #eceff1', margin: '0.5rem 0' }} />

                  {/* Restore dependency */}
                  {infoRow('To restore', dependencyNote)}

                  {/* Retention forecast */}
                  {infoRow('Retention', retentionNote)}

                  {/* Immutability status */}
                  {infoRow('Immutability', immutabilityNote)}

                  {/* Archive eligibility */}
                  {archiveNote && infoRow('Archive', archiveNote)}

                  {/* Pruned-from-capacity note */}
                  {selectedWasPrunedFromCapacity && (
                    <div style={{ fontSize: '0.82rem', marginTop: '0.4rem', color: '#6d4c41', background: '#efebe9', border: '1px solid #d7ccc8', borderRadius: '6px', padding: '0.4rem 0.5rem' }}>
                      This point was copied to Capacity, then pruned after the chain's GFS full was preserved in Archive.
                    </div>
                  )}

                  <div style={{ borderTop: '1px solid #eceff1', margin: '0.5rem 0' }} />

                  {/* Tier journey timeline */}
                  <div style={{ fontSize: '0.78rem', color: '#78909c', marginBottom: '0.3rem' }}>Tier journey</div>
                  {journeySteps.length > 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' }}>
                      {journeySteps.map((step, idx) => (
                        <React.Fragment key={`${selected.id}-journey-${idx}`}>
                          <div style={{
                            background: tierBg[step.tier] || '#607d8b',
                            color: '#fff',
                            borderRadius: '4px',
                            padding: '3px 9px',
                            fontSize: '0.8rem',
                            fontWeight: step.isCurrent ? 'bold' : 'normal',
                            outline: step.isCurrent ? '2px solid #37474f' : 'none',
                            outlineOffset: '1px',
                          }}>
                            {step.tier}
                            <span style={{ marginLeft: '5px', opacity: 0.85, fontWeight: 'normal' }}>
                              {step.isCurrent ? `${step.daysInTier}d ★` : `${step.daysInTier}d`}
                            </span>
                          </div>
                          {idx < journeySteps.length - 1 && (
                            <span style={{ color: '#90a4ae', fontSize: '1rem' }}>→</span>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.82rem', color: '#90a4ae' }}>No tier history recorded (point has not moved tiers yet).</div>
                  )}
                </>
              );
            })()}
            {!selectedRestorePointId && (
              <div style={{ fontSize: '0.85rem', color: '#607d8b' }}>
                Select a restore point from the catalog or tier contents to view its info.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom controls (duplicate for convenience — no need to scroll back up) */}
      <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #e0e0e0' }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
          borderRadius: '999px',
          background: '#eef3f7',
          border: '1px solid #d7e1e8',
          color: '#455a64',
          fontSize: '0.8rem',
          fontWeight: 600,
          marginRight: '0.25rem',
          padding: '2px 8px'
        }}>
          <span>{simDateMeta.isoDate}</span>
          <span style={{ color: '#607d8b' }}>{simDateMeta.weekday}</span>
        </span>
        <span style={{ color: '#d0d0d0', margin: '0 0.2rem', userSelect: 'none' }}>│</span>
        {([1, 7, 30] as const).map(days => (
          <button
            key={`bottom-${days}`}
            onClick={() => { setActivityLogFilter(null); onNextDay(days); }}
            style={{
              padding: '3px 13px',
              borderRadius: '999px',
              border: '1px solid #90caf9',
              background: '#e3f2fd',
              color: '#1565c0',
              fontWeight: 700,
              fontSize: '0.81rem',
              cursor: 'pointer',
              lineHeight: '1.6',
            }}
          >
            ▶ +{days} Day{days > 1 ? 's' : ''}
          </button>
        ))}
        <span style={{ color: '#d0d0d0', margin: '0 0.2rem', userSelect: 'none' }}>│</span>
        {([1, 2, 3] as const).map(yr => {
          const daysLeft = computeDaysToYear(yr);
          const disabled = daysLeft <= 0;
          return (
            <button
              key={`bottom-year-${yr}`}
              disabled={disabled}
              title={disabled ? `Already at or past Year ${yr}` : `Jump to Year ${yr} (${daysLeft} days from now)`}
              onClick={() => { setActivityLogFilter(30); onNextDay(daysLeft); }}
              style={{
                padding: '3px 13px',
                borderRadius: '999px',
                border: `1px solid ${disabled ? '#e0e0e0' : '#ffcc80'}`,
                background: disabled ? '#f5f5f5' : '#fff3e0',
                color: disabled ? '#bbb' : '#bf360c',
                fontWeight: 700,
                fontSize: '0.81rem',
                cursor: disabled ? 'not-allowed' : 'pointer',
                lineHeight: '1.6',
                opacity: disabled ? 0.55 : 1,
              }}
            >
              ⏩ Year {yr}
            </button>
          );
        })}
      </div>
    </div>
  );
};
