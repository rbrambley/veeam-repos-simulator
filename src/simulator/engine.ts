// Simulation engine for Veeam Backup Simulator
// This module will handle day-by-day simulation of backup jobs, chains, retention, and storage usage.

import { SimulationState, BackupJob, Repository, BackupChain, RestorePoint, BlockObject, SOBRTier, BackupGeneration } from '../models/veeam.ts';
import { computeGfsStoredContributionTB } from '../models/gfsSizing.ts';

interface Modifier {
  maxDays: number;
  modifier: number;
}

const GFS_MODIFIERS: Modifier[] = [
  { maxDays: 2, modifier: 1 },
  { maxDays: 14, modifier: 3 },
  { maxDays: 38, modifier: 5 },
  { maxDays: 100, modifier: 9 },
  { maxDays: 193, modifier: 12 },
  { maxDays: 286, modifier: 15 },
  { maxDays: 379, modifier: 18 },
  { maxDays: 1095, modifier: 1000 },
];

export function CalculateGfsSize(baseSize: number, dailyChangeRate: number, ageInDays: number): number {
  const safeBaseSize = Number.isFinite(baseSize) ? baseSize : 0;
  const safeDailyChangeRate = Number.isFinite(dailyChangeRate) ? dailyChangeRate : 0;
  const safeAgeInDays = Number.isFinite(ageInDays) ? Math.max(0, Math.floor(ageInDays)) : 0;

  let modifier = 1;
  for (let i = GFS_MODIFIERS.length - 1; i >= 0; i -= 1) {
    const row = GFS_MODIFIERS[i];
    if (row.maxDays < safeAgeInDays) {
      modifier = row.modifier;
      break;
    }
  }

  return safeBaseSize * (1 + safeDailyChangeRate * modifier);
}

export class VeeamSimulator {
  state: SimulationState;

  private setRestorePointSize(rp: RestorePoint, sizeTB: number) {
    rp.sizeGB = sizeTB;
    for (const blockId of rp.referencedBlockIds) {
      const block = this.state.blocks.find(b => b.id === blockId);
      if (block) {
        block.sizeGB = sizeTB;
      }
    }
  }

  private applyGfsSizing(job: BackupJob, rp: RestorePoint) {
    if (!rp.isGFS) return;
    // A GFS-tagged SyntheticFull is still a full backup storing all data.
    // Monthly/yearly tags only extend retention lifetime; they do not reduce
    // physical size. Size should follow source growth at the point date.
    const fullSizeAtPointTB = this.getExpectedFullSizeTB(job, rp.date);
    this.setRestorePointSize(rp, fullSizeAtPointTB);
  }

  private ensureGenerationState() {
    if (!this.state.generations) {
      this.state.generations = [];
    }
  }

  private parseISODate(date: string): Date {
    return new Date(`${date}T00:00:00.000Z`);
  }

  private toISODate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private addDaysISO(iso: string, days: number): string {
    const d = this.parseISODate(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return this.toISODate(d);
  }

  private getGenerationPeriodDays(repo?: Repository): number {
    return Math.max(1, repo?.sobrConfig?.generationPeriodDays ?? 10);
  }

  private usesGenerationLifecycle(repo?: Repository): boolean {
    // Current behavior model: generations are for SOBR object tiers.
    // ObjectStorage repo type support will be added when implemented.
    return repo?.type === 'SOBR';
  }

  private getTierImmutabilityDays(repo: Repository | undefined, tier: SOBRTier): number {
    const cfg = repo?.sobrConfig;
    if (!cfg) {
      // Non-SOBR repositories use repository-level immutability for their primary tier.
      if (tier === 'Performance') return Math.max(0, repo?.immutabilityDays ?? 0);
      return 0;
    }
    // Current model defaults Performance to block storage (ReFS/XFS), so GEN immutability
    // gates only apply to object tiers.
    if (tier === 'Performance') return 0;
    if (tier === 'Capacity') return Math.max(0, cfg.capacityImmutabilityDays ?? 0);
    return Math.max(0, cfg.archiveImmutabilityDays ?? 0);
  }

  private getGenerationForPoint(rp: RestorePoint): BackupGeneration | undefined {
    this.ensureGenerationState();
    if (!rp.generationId) return undefined;
    return this.state.generations!.find(g => g.id === rp.generationId);
  }

  private registerPointInGeneration(job: BackupJob, chain: BackupChain, rp: RestorePoint) {
    const repo = this.state.repositories.find(r => r.id === job.repositoryId);
    if (!this.usesGenerationLifecycle(repo)) {
      return;
    }

    this.ensureGenerationState();
    const periodDays = this.getGenerationPeriodDays(repo);
    const elapsedDays = this.state.startDate
      ? Math.floor((this.parseISODate(rp.date).getTime() - this.parseISODate(this.state.startDate).getTime()) / 86400000)
      : 0;
    const windowIndex = Math.max(0, Math.floor(elapsedDays / periodDays));
    const windowStart = this.state.startDate
      ? this.addDaysISO(this.state.startDate, windowIndex * periodDays)
      : rp.date;
    const windowEnd = this.addDaysISO(windowStart, periodDays - 1);
    const generationId = `gen-${job.id}-${windowStart}`;

    let generation = this.state.generations!.find(g => g.id === generationId);
    if (!generation) {
      generation = {
        id: generationId,
        jobId: job.id,
        chainId: chain.id,
        windowStartDate: windowStart,
        windowEndDate: windowEnd,
        pointIds: [],
        deleteOn: this.addDaysISO(windowEnd, Math.max(1, job.retention?.slaDays || job.retention?.restorePoints || 7)),
      };
      this.state.generations!.push(generation);
    }

    generation.chainId = chain.id;
    rp.generationId = generation.id;
    if (!generation.pointIds.includes(rp.id)) {
      generation.pointIds.push(rp.id);
    }
  }

  private markGenerationTierEntered(generation: BackupGeneration, tier: SOBRTier, enteredAt: string, repo?: Repository) {
    if (tier === 'Performance') {
      if (!generation.performanceEnteredAt) generation.performanceEnteredAt = enteredAt;
      generation.performanceImmutableUntil = this.addDaysISO(
        generation.performanceEnteredAt,
        this.getTierImmutabilityDays(repo, 'Performance')
      );
      return;
    }

    if (tier === 'Capacity') {
      if (!generation.capacityEnteredAt) generation.capacityEnteredAt = enteredAt;
      generation.capacityImmutableUntil = this.addDaysISO(
        generation.capacityEnteredAt,
        this.getTierImmutabilityDays(repo, 'Capacity')
      );
      return;
    }

    if (!generation.archiveEnteredAt) generation.archiveEnteredAt = enteredAt;
    generation.archiveImmutableUntil = this.addDaysISO(
      generation.archiveEnteredAt,
      this.getTierImmutabilityDays(repo, 'Archive')
    );
  }

  private recomputeGenerationDeleteOn(job: BackupJob, generation: BackupGeneration) {
    const points = generation.pointIds
      .map(id => this.state.restorePoints.find(rp => rp.id === id))
      .filter((rp): rp is RestorePoint => !!rp);

    const retentionDays = Math.max(1, job.retention?.slaDays || job.retention?.restorePoints || 7);
    let deleteOn = this.addDaysISO(generation.windowEndDate, retentionDays);

    for (const rp of points) {
      if (rp.isWeeklyGFS && (job.gfsPolicy?.weekly ?? 0) > 0) {
        const candidate = this.addDaysISO(rp.date, job.gfsPolicy!.weekly * 7);
        if (this.parseISODate(candidate) > this.parseISODate(deleteOn)) deleteOn = candidate;
      }
      if (rp.isMonthlyGFS && (job.gfsPolicy?.monthly ?? 0) > 0) {
        const candidate = this.addDaysISO(rp.date, job.gfsPolicy!.monthly * 30);
        if (this.parseISODate(candidate) > this.parseISODate(deleteOn)) deleteOn = candidate;
      }
      if (rp.isYearlyGFS && (job.gfsPolicy?.yearly ?? 0) > 0) {
        const candidate = this.addDaysISO(rp.date, job.gfsPolicy!.yearly * 365);
        if (this.parseISODate(candidate) > this.parseISODate(deleteOn)) deleteOn = candidate;
      }
    }

    generation.deleteOn = deleteOn;
  }

  private generationPerformanceImmutableExpired(generation: BackupGeneration, currentDate: Date): boolean {
    if (!generation.performanceImmutableUntil) return true;
    return currentDate.getTime() >= this.parseISODate(generation.performanceImmutableUntil).getTime();
  }

  private generationDeletionUnlocked(generation: BackupGeneration, chainPoints: RestorePoint[], currentDate: Date): boolean {
    const currentIso = this.toISODate(currentDate);
    if (this.parseISODate(currentIso).getTime() < this.parseISODate(generation.deleteOn).getTime()) {
      return false;
    }

    const genPoints = chainPoints.filter(p => p.generationId === generation.id);
    const hasPerf = genPoints.some(p => this.hasTierData(p, 'Performance'));
    const hasCap = genPoints.some(p => this.hasTierData(p, 'Capacity'));
    const hasArch = genPoints.some(p => this.hasTierData(p, 'Archive'));

    if (hasPerf && generation.performanceImmutableUntil && this.parseISODate(currentIso) < this.parseISODate(generation.performanceImmutableUntil)) {
      return false;
    }
    if (hasCap && generation.capacityImmutableUntil && this.parseISODate(currentIso) < this.parseISODate(generation.capacityImmutableUntil)) {
      return false;
    }
    if (hasArch && generation.archiveImmutableUntil && this.parseISODate(currentIso) < this.parseISODate(generation.archiveImmutableUntil)) {
      return false;
    }

    return true;
  }

  private recomputeAllGenerationDeleteOn() {
    this.ensureGenerationState();
    for (const generation of this.state.generations!) {
      const job = this.state.jobs.find(j => j.id === generation.jobId);
      if (!job) continue;
      this.recomputeGenerationDeleteOn(job, generation);
    }
  }

  private isCopyEnabled(cfg: { copyEnabled?: boolean }): boolean {
    return !!cfg.copyEnabled;
  }

  private isMoveEnabled(cfg: { moveEnabled?: boolean }): boolean {
    return cfg.moveEnabled ?? true;
  }

  private hasTierData(rp: RestorePoint, tier: SOBRTier): boolean {
    if (rp.hasPerformanceData === undefined && rp.hasCapacityData === undefined && rp.hasArchiveData === undefined) {
      const legacyTier = rp.sobrTier ?? 'Performance';
      return legacyTier === tier;
    }
    if (tier === 'Performance') return !!rp.hasPerformanceData;
    if (tier === 'Capacity') return !!rp.hasCapacityData;
    return !!rp.hasArchiveData;
  }

  private getJobForRestorePoint(rp: RestorePoint): BackupJob | undefined {
    const chain = this.state.chains.find(c => c.id === rp.chainId);
    if (chain) return this.state.jobs.find(j => j.id === chain.jobId);
    return this.state.jobs.find(j => rp.id.startsWith(`${j.id}-`));
  }

  private getExpectedFullSizeTB(job: BackupJob, pointDateIso: string): number {
    const pointDate = this.parseISODate(pointDateIso);
    const elapsedDays = this.state.startDate
      ? (pointDate.getTime() - this.parseISODate(this.state.startDate).getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    const annualGrowth = (job.annualGrowthRatePct ?? 10) / 100;
    const effectiveSourceTB = (job.sourceDataTB || 1) * Math.pow(1 + annualGrowth, elapsedDays / 365);
    return effectiveSourceTB * 0.5;
  }

  private getExpectedIncrementalSizeTB(job: BackupJob, pointDateIso: string): number {
    const pointDate = this.parseISODate(pointDateIso);
    const elapsedDays = this.state.startDate
      ? (pointDate.getTime() - this.parseISODate(this.state.startDate).getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    const annualGrowth = (job.annualGrowthRatePct ?? 10) / 100;
    const effectiveSourceTB = (job.sourceDataTB || 1) * Math.pow(1 + annualGrowth, elapsedDays / 365);
    const changeRate = (job.dailyChangeRatePct ?? 5) / 100;
    return effectiveSourceTB * changeRate * 0.5;
  }

  private getRestorePointSizeInTier(rp: RestorePoint, tier: SOBRTier): number {
    if (rp.isGFS) {
      const job = this.getJobForRestorePoint(rp);
      if (!job) return rp.sizeGB;

      // Determine if this point is the outermost (oldest) of its GFS class for
      // this job — outermost points absorb extra blocks from the uncovered period
      // before them and receive a higher storage contribution factor.
      const jobChainIds = new Set(
        this.state.chains.filter(c => c.jobId === job.id).map(c => c.id)
      );
      // Include detached GFS points (chain was deleted but point is preserved)
      // by falling back to the same ID-prefix convention as getJobForRestorePoint.
      const jobGfsPoints = this.state.restorePoints.filter(
        p => p.isGFS && (jobChainIds.has(p.chainId) || p.id.startsWith(`${job.id}-`))
      );
      const oldestWeeklyDate = jobGfsPoints
        .filter(p => p.isWeeklyGFS && !p.isMonthlyGFS && !p.isYearlyGFS)
        .map(p => p.date)
        .sort()[0] ?? null;
      const oldestMonthlyDate = jobGfsPoints
        .filter(p => p.isMonthlyGFS)
        .map(p => p.date)
        .sort()[0] ?? null;

      const fullSizeAtPointTB = this.getExpectedFullSizeTB(job, rp.date);
      const changeRate = (job.dailyChangeRatePct ?? 5) / 100;
      return computeGfsStoredContributionTB({
        pointSizeTB: fullSizeAtPointTB,
        dailyChangeRate: changeRate,
        hasWeekly: !!rp.isWeeklyGFS,
        hasMonthly: !!rp.isMonthlyGFS,
        hasYearly: !!rp.isYearlyGFS,
        weeklyPolicyCount: job.gfsPolicy?.weekly ?? 0,
        isOutermostWeekly: rp.isWeeklyGFS && !rp.isMonthlyGFS && !rp.isYearlyGFS && rp.date === oldestWeeklyDate,
        isOutermostMonthly: !!rp.isMonthlyGFS && rp.date === oldestMonthlyDate,
      });
    }
    if (rp.type !== 'SyntheticFull') return rp.sizeGB;
    const job = this.getJobForRestorePoint(rp);
    if (!job) return rp.sizeGB;
    if (rp.isGlobalBase || (rp.baseTiers || []).includes(tier)) {
      return this.getExpectedFullSizeTB(job, rp.date);
    }
    return this.getExpectedIncrementalSizeTB(job, rp.date);
  }

  getRestorePointSizeForTier(rpId: string, tier: SOBRTier): number {
    const rp = this.state.restorePoints.find(p => p.id === rpId);
    if (!rp) return 0;
    return this.getRestorePointSizeInTier(rp, tier);
  }

  constructor(initialState: SimulationState) {
    this.state = initialState;
    this.ensureGenerationState();
    // Ensure first full backup is created on the initial date for each job
    const actions: string[] = [];
    for (const job of this.state.jobs) {
      let activeChain = this.state.chains.find(c => c.jobId === job.id && c.status === 'Active');
      if (!activeChain || activeChain.restorePoints.length === 0) {
        const date = this.parseISODate(this.state.date);
        const rp = this.createRestorePoint(job, date, 'Full');
        actions.push(`Job '${job.name}' created a Full restore point (${rp.sizeGB.toFixed(3)} TB) in Chain ${rp.chainId}.`);

        const repo = this.state.repositories.find(r => r.id === job.repositoryId);
        if (repo?.type === 'SOBR' && repo.sobrConfig && this.isCopyEnabled(repo.sobrConfig)) {
          actions.push(`Chain ${rp.chainId}: 1 restore point(s) copied to Capacity tier (Copy mode).`);
        }
      }
    }
    if (actions.length > 0) {
      this.lastDailyExplanation = actions.join(' ');
    }
  }

  // Advance simulation by one day
  nextDay() {
    // Advance simulation date by one day
    const currentDate = this.parseISODate(this.state.date);
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    this.state.date = currentDate.toISOString().slice(0, 10);

    // Track daily actions for explanation
    const actions: string[] = [];

    // Run scheduled jobs with synthetic full logic
    for (const job of this.state.jobs) {
      const retentionCount = job.retention?.restorePoints || 7;
      let activeChain = this.state.chains.find(c => c.jobId === job.id && c.status === 'Active');
      if (!activeChain || activeChain.restorePoints.length === 0) {
        // Always create a full on the very first day (if no chain exists)
        const rp = this.createRestorePoint(job, currentDate, 'Full');
        actions.push(`Job '${job.name}' created a Full restore point (${rp.sizeGB.toFixed(3)} TB).`);
        continue;
      }

      if (this.shouldRunJobToday(job, currentDate)) {
        activeChain = this.state.chains.find(c => c.jobId === job.id && c.status === 'Active');
        let rp;

        // GFS: if today matches a GFS schedule, force a SyntheticFull and tag it
        if (job.gfsPolicy && this.isGFSDay(job, currentDate)) {
          if (activeChain) {
            activeChain.status = 'Inactive';
            activeChain.inactiveSince = currentDate.toISOString().slice(0, 10);
            activeChain.offloadComplete = false;
            activeChain.offloadCompletedAt = undefined;
            activeChain.performancePrunedAt = undefined;
          }
          rp = this.createRestorePoint(job, currentDate, 'SyntheticFull');
          this.tagGFSRestorePoint(job, rp, currentDate, actions);
          actions.push(`Job '${job.name}' created a GFS SyntheticFull restore point (${rp.sizeGB.toFixed(3)} TB) in Chain ${rp.chainId}.`);
        } else if (
          (job.type === 'SyntheticFull' || job.type === 'ForwardIncremental') &&
          this.isSyntheticFullDay(job, currentDate)
        ) {
          // Scheduled SyntheticFull day reached — close current chain and start a new one
          if (activeChain) {
            activeChain.status = 'Inactive';
            activeChain.inactiveSince = currentDate.toISOString().slice(0, 10);
            activeChain.offloadComplete = false;
            activeChain.offloadCompletedAt = undefined;
            activeChain.performancePrunedAt = undefined;
          }
          rp = this.createRestorePoint(job, currentDate, 'SyntheticFull');
          actions.push(`Job '${job.name}' created a SyntheticFull restore point (${rp.sizeGB.toFixed(3)} TB) in Chain ${rp.chainId}. Previous chain closed and new chain started.`);
          this.tagGFSRestorePoint(job, rp, currentDate, actions);
        } else {
          rp = this.createRestorePoint(job, currentDate);
          this.tagGFSRestorePoint(job, rp, currentDate, actions);
          actions.push(`Job '${job.name}' created a ${rp.type} restore point (${rp.sizeGB.toFixed(3)} TB) in Chain ${rp.chainId}.`);
        }
      }
    }

    // SOBR offload: move restore points between tiers based on age
    const offloadActions = this.applySOBROffload(currentDate);
    actions.push(...offloadActions);

    // Apply retention/SLA daily so expiry is enforced on the exact day it is due.
    const retentionActions = this.applyRetentionAndGFS(currentDate);
    actions.push(...retentionActions);

    this.recomputeAllGenerationDeleteOn();

    // Promote chain bases for all repos (DAS and non-SOBR after retention deletes chains)
    const promoteActions = this.promoteChainBases();
    actions.push(...promoteActions);

    // Save daily explanation after all daily activity (including SOBR moves)
    this.lastDailyExplanation = actions.join(' ');
  }
  // GFS tagging: applies W/M/Y tags to Full or SyntheticFull points (type is never changed)
  tagGFSRestorePoint(job: BackupJob, rp: RestorePoint, date: Date, actions: string[]) {
    if (!job.gfsPolicy) return;
    // GFS can only be applied to Full or SyntheticFull restore points (Veeam behavior)
    if (rp.type !== 'Full' && rp.type !== 'SyntheticFull') return;
    if (date.getUTCDay() !== 6) return; // GFS only tags on Saturdays
    const tags: string[] = [];
    // Weekly: every Saturday
    if (job.gfsPolicy.weekly) {
      rp.isWeeklyGFS = true;
      tags.push('Weekly');
    }
    // Monthly: last Saturday of the month
    if (job.gfsPolicy.monthly) {
      const nextSat = new Date(date);
      nextSat.setUTCDate(date.getUTCDate() + 7);
      if (nextSat.getUTCMonth() !== date.getUTCMonth()) {
        rp.isMonthlyGFS = true;
        tags.push('Monthly');
      }
    }
    // Yearly: last Saturday of December
    if (job.gfsPolicy.yearly && date.getUTCMonth() === 11) {
      const nextSat = new Date(date);
      nextSat.setUTCDate(date.getUTCDate() + 7);
      if (nextSat.getUTCMonth() !== 11) {
        rp.isYearlyGFS = true;
        tags.push('Yearly');
      }
    }
    if (tags.length > 0) {
      rp.isGFS = true;
      this.applyGfsSizing(job, rp);
      actions.push(`Restore point on ${rp.date} tagged as GFS: ${tags.join(' + ')}.`);
    }
  }

  // SOBR offload: promote restore points between tiers based on mode and age.
  applySOBROffload(currentDate: Date): string[] {
    const actions: string[] = [];
    for (const repo of this.state.repositories) {
      if (repo.type !== 'SOBR' || !repo.sobrConfig) continue;
      const cfg = repo.sobrConfig;
      const copyEnabled = this.isCopyEnabled(cfg);
      const moveEnabled = this.isMoveEnabled(cfg);
      const jobs = this.state.jobs.filter(j => j.repositoryId === repo.id);
      const jobIds = jobs.map(j => j.id);

      const repoPoints = this.state.restorePoints.filter(rp => {
        const chain = this.state.chains.find(c => c.id === rp.chainId);
        return chain && jobIds.includes(chain.jobId);
      });

      const gfsOrphanPoints = this.state.restorePoints.filter(rp =>
        rp.chainId.startsWith('gfs-') && jobIds.some(jid => rp.id.startsWith(jid + '-'))
      );

      const byChain: Record<string, RestorePoint[]> = {};
      for (const rp of repoPoints) {
        if (!byChain[rp.chainId]) byChain[rp.chainId] = [];
        byChain[rp.chainId].push(rp);
      }

      const currentDateIso = currentDate.toISOString().slice(0, 10);

      for (const [chainId, points] of Object.entries(byChain)) {
        const chain = this.state.chains.find(c => c.id === chainId);
        if (!chain) continue;
        const job = jobs.find(j => j.id === chain.jobId);
        if (!job) continue;
        const chainGenerations = (this.state.generations || []).filter(g => g.chainId === chain.id);

        const newlyCopiedToday: RestorePoint[] = [];
        for (const rp of points) {
          if (!rp.sobrTier) rp.sobrTier = 'Performance';
          if (!rp.sobrTierEnteredAt) rp.sobrTierEnteredAt = rp.date;
          if (rp.hasPerformanceData === undefined && rp.hasCapacityData === undefined && rp.hasArchiveData === undefined) {
            rp.hasPerformanceData = (rp.sobrTier ?? 'Performance') === 'Performance';
            rp.hasCapacityData = rp.sobrTier === 'Capacity';
            rp.hasArchiveData = rp.sobrTier === 'Archive';
          }
          if (copyEnabled) {
            if (rp.capacityCopyCreatedAt === undefined) {
              rp.hasCapacityData = true;
              rp.capacityCopyCreatedAt = currentDateIso;
              newlyCopiedToday.push(rp);
            } else if (rp.capacityCopyCreatedAt === currentDateIso) {
              // Copy may be stamped at creation time; still surface activity for today's copy event.
              newlyCopiedToday.push(rp);
            }
          }
        }
        if (newlyCopiedToday.length > 0) {
          actions.push(`Chain ${chain.id}: ${newlyCopiedToday.length} restore point(s) copied to Capacity tier (Copy mode).`);
        }

        // Move operates on inactive chains and preserves current move behavior by default.
        if (moveEnabled && chain.status === 'Inactive' && !chain.offloadComplete) {
          const perfPoints = points.filter(p => this.hasTierData(p, 'Performance'));
          if (perfPoints.length > 0) {
            const newestPointDateIso = points
              .map(p => p.date)
              .sort()
              .slice(-1)[0];
            const newestPointDate = this.parseISODate(newestPointDateIso);
            const newestPointAgeDays = (currentDate.getTime() - newestPointDate.getTime()) / (1000 * 60 * 60 * 24);

            const perfGenerationIds = new Set(
              perfPoints
                .map(p => p.generationId)
                .filter((id): id is string => !!id)
            );

            const immutableBlockedGeneration = chainGenerations.find(g =>
              perfGenerationIds.has(g.id) && !this.generationPerformanceImmutableExpired(g, currentDate)
            );

            if (newestPointAgeDays >= cfg.offloadAfterDays && !immutableBlockedGeneration) {
              for (const rp of perfPoints) {
                if (!rp.hasCapacityData) {
                  rp.hasCapacityData = true;
                  rp.capacityCopyCreatedAt = currentDateIso;
                }
                if (rp.sobrTier === 'Performance') {
                  rp.sobrTier = 'Capacity';
                  rp.sobrTierEnteredAt = currentDateIso;
                  rp.tierMoveHistory = rp.tierMoveHistory || [];
                  rp.tierMoveHistory.push({ tier: 'Capacity', date: currentDateIso });
                }

                const gen = this.getGenerationForPoint(rp);
                if (gen) {
                  this.markGenerationTierEntered(gen, 'Capacity', currentDateIso, repo);
                }
              }
              chain.offloadComplete = true;
              chain.offloadCompletedAt = currentDateIso;
              actions.push(
                copyEnabled
                  ? `Inactive chain ${chain.id} offload completed to Capacity (${perfPoints.length} points; Capacity copy reused).`
                  : `Inactive chain ${chain.id} offloaded in full Performance -> Capacity (${perfPoints.length} points uploaded).`
              );
            } else if (immutableBlockedGeneration) {
              actions.push(`Inactive chain ${chain.id} offload deferred: GEN ${immutableBlockedGeneration.id} is still immutable on Performance.`);
            }
          }
        }

        // Archive transition: only GFS-tagged points move to Archive (non-GFS stops at Capacity).
        // Archive remains downstream of the offload window even in Copy mode.
        if (cfg.hasArchiveTier) {
          const capPoints = points.filter(p => this.hasTierData(p, 'Capacity') && p.isGFS === true);
          const toArchive: RestorePoint[] = [];
          for (const rp of capPoints) {
            const pointAgeDays = (currentDate.getTime() - this.parseISODate(rp.date).getTime()) / (1000 * 60 * 60 * 24);
            const anchorIso = copyEnabled
              ? (rp.capacityMoveFinalizedAt || rp.capacityCopyCreatedAt || rp.sobrTierEnteredAt || rp.date)
              : (rp.sobrTierEnteredAt || rp.date);
            const anchorDate = this.parseISODate(anchorIso);
            const capTierAgeDays = (currentDate.getTime() - anchorDate.getTime()) / (1000 * 60 * 60 * 24);
            const archiveEligible = copyEnabled
              ? pointAgeDays >= (cfg.offloadAfterDays + cfg.archiveAfterDays)
              : capTierAgeDays >= cfg.archiveAfterDays;
            if (archiveEligible) {
              toArchive.push(rp);
            }
          }

          if (toArchive.length > 0) {
            for (const rp of toArchive) {
              rp.baseTiers = (rp.baseTiers || []).filter(t => t !== 'Capacity');
              rp.hasCapacityData = false;
              rp.hasArchiveData = true;
              rp.sobrTier = 'Archive';
              rp.sobrTierEnteredAt = currentDateIso;
              rp.tierMoveHistory = rp.tierMoveHistory || [];
              rp.tierMoveHistory.push({ tier: 'Archive', date: currentDateIso });

              const gen = this.getGenerationForPoint(rp);
              if (gen) {
                this.markGenerationTierEntered(gen, 'Archive', currentDateIso, repo);
              }
            }

            if (copyEnabled) {
              let clearedNonGfsCapacity = 0;
              for (const rp of points) {
                if (!rp.isGFS && rp.hasCapacityData) {
                  rp.baseTiers = (rp.baseTiers || []).filter(t => t !== 'Capacity');
                  rp.hasCapacityData = false;
                  clearedNonGfsCapacity += 1;
                }
              }
              if (clearedNonGfsCapacity > 0) {
                actions.push(`Chain ${chain.id}: cleared Capacity residue for ${clearedNonGfsCapacity} non-GFS restore point(s) after GFS archive.`);
              }
            }

            actions.push(`Inactive chain ${chain.id} offloaded in full Capacity -> Archive (${toArchive.length} points).`);
          }
        }
      }

      // Detached GFS points follow the same mode rules as chain points.
      for (const rp of gfsOrphanPoints) {
        if (!rp.sobrTier) rp.sobrTier = 'Performance';
        if (!rp.sobrTierEnteredAt) rp.sobrTierEnteredAt = rp.date;
        if (rp.hasPerformanceData === undefined && rp.hasCapacityData === undefined && rp.hasArchiveData === undefined) {
          rp.hasPerformanceData = (rp.sobrTier ?? 'Performance') === 'Performance';
          rp.hasCapacityData = rp.sobrTier === 'Capacity';
          rp.hasArchiveData = rp.sobrTier === 'Archive';
        }
        if (copyEnabled) {
          if (rp.capacityCopyCreatedAt === undefined) {
            rp.hasCapacityData = true;
            rp.capacityCopyCreatedAt = currentDateIso;
            actions.push(`GFS point ${rp.id} copied to Capacity tier (Copy mode).`);
          } else if (rp.capacityCopyCreatedAt === currentDateIso) {
            actions.push(`GFS point ${rp.id} copied to Capacity tier (Copy mode).`);
          }
        }

        if (moveEnabled && this.hasTierData(rp, 'Performance')) {
          const anchor = rp.sobrTierEnteredAt || rp.date;
          const ageDays = (currentDate.getTime() - this.parseISODate(anchor).getTime()) / (1000 * 60 * 60 * 24);
          if (ageDays >= cfg.offloadAfterDays) {
            rp.baseTiers = (rp.baseTiers || []).filter(t => t !== 'Performance');
            rp.hasPerformanceData = false;
            if (!rp.hasCapacityData) {
              rp.hasCapacityData = true;
              rp.capacityCopyCreatedAt = currentDateIso;
            }
            rp.capacityMoveFinalizedAt = currentDateIso;
            if (rp.sobrTier !== 'Capacity') {
              rp.sobrTier = 'Capacity';
              rp.sobrTierEnteredAt = currentDateIso;
              rp.tierMoveHistory = rp.tierMoveHistory || [];
              rp.tierMoveHistory.push({ tier: 'Capacity', date: currentDateIso });
            }
            const gen = this.getGenerationForPoint(rp);
            if (gen) {
              this.markGenerationTierEntered(gen, 'Capacity', currentDateIso, repo);
            }
            actions.push(`GFS point ${rp.id} offloaded Performance -> Capacity (${ageDays.toFixed(0)} days old).`);
          }
        }

        if (cfg.hasArchiveTier && this.hasTierData(rp, 'Capacity')) {
          const anchorIso = copyEnabled
            ? (rp.capacityMoveFinalizedAt || rp.capacityCopyCreatedAt || rp.sobrTierEnteredAt || rp.date)
            : (rp.sobrTierEnteredAt || rp.date);
          const ageDays = (currentDate.getTime() - this.parseISODate(anchorIso).getTime()) / (1000 * 60 * 60 * 24);
          const pointAgeDays = (currentDate.getTime() - this.parseISODate(rp.date).getTime()) / (1000 * 60 * 60 * 24);
          const archiveEligible = copyEnabled
            ? pointAgeDays >= (cfg.offloadAfterDays + cfg.archiveAfterDays)
            : ageDays >= cfg.archiveAfterDays;
          if (archiveEligible) {
            rp.baseTiers = (rp.baseTiers || []).filter(t => t !== 'Capacity');
            rp.hasCapacityData = false;
            rp.hasArchiveData = true;
            rp.sobrTier = 'Archive';
            rp.sobrTierEnteredAt = currentDateIso;
            rp.tierMoveHistory = rp.tierMoveHistory || [];
            rp.tierMoveHistory.push({ tier: 'Archive', date: currentDateIso });
            const gen = this.getGenerationForPoint(rp);
            if (gen) {
              this.markGenerationTierEntered(gen, 'Archive', currentDateIso, repo);
            }
            actions.push(`GFS point ${rp.id} offloaded Capacity -> Archive (${ageDays.toFixed(0)} days old).`);
          }
        }
      }

      this.normalizeRepoTierBases([...repoPoints, ...gfsOrphanPoints], cfg, actions);
    }
    return actions;
  }

  normalizeRepoTierBases(points: RestorePoint[], cfg: { hasArchiveTier: boolean }, actions: string[]) {
    const tiers: SOBRTier[] = cfg.hasArchiveTier
      ? ['Performance', 'Capacity', 'Archive']
      : ['Performance', 'Capacity'];

    for (const tier of tiers) {
      const tierPoints = points.filter(p => this.hasTierData(p, tier));
      const eligibleAll = tierPoints
        .filter(p => p.type === 'Full' || p.type === 'SyntheticFull')
        .sort((a, b) => this.parseISODate(a.date).getTime() - this.parseISODate(b.date).getTime());
      const eligibleInactive = eligibleAll.filter(p => {
        const chain = this.state.chains.find(c => c.id === p.chainId);
        // Detached preserved points are treated as inactive for base selection.
        return !chain || chain.status === 'Inactive';
      });
      const eligible = eligibleInactive.length > 0 ? eligibleInactive : eligibleAll;

      const previousBaseIds = tierPoints
        .filter(p => (p.baseTiers || []).includes(tier))
        .map(p => p.id)
        .sort()
        .join('|');

      for (const point of tierPoints) {
        point.baseTiers = (point.baseTiers || []).filter(t => t !== tier);
      }

      const basePoint = eligible[0];
      if (basePoint) {
        basePoint.baseTiers = [...new Set([...(basePoint.baseTiers || []), tier])];
        basePoint.isTierSeed = true;

        if (basePoint.type === 'SyntheticFull' && !basePoint.isGFS) {
          const chain = this.state.chains.find(c => c.id === basePoint.chainId);
          const job = chain
            ? this.state.jobs.find(j => j.id === chain.jobId)
            : this.state.jobs.find(j => basePoint.id.startsWith(`${j.id}-`));
          if (job) {
            const promotedDate = this.parseISODate(basePoint.date);
            const elapsedDays = this.state.startDate
              ? (promotedDate.getTime() - this.parseISODate(this.state.startDate).getTime()) / (1000 * 60 * 60 * 24)
              : 0;
            const annualGrowth = (job.annualGrowthRatePct ?? 10) / 100;
            const effectiveSourceTB = (job.sourceDataTB || 1) * Math.pow(1 + annualGrowth, elapsedDays / 365);
            const fullSizeTB = effectiveSourceTB * 0.5;
            basePoint.sizeGB = fullSizeTB;
            for (const blockId of basePoint.referencedBlockIds) {
              const block = this.state.blocks.find(b => b.id === blockId);
              if (block) block.sizeGB = fullSizeTB;
            }
          }
        }

        const newBaseIds = basePoint.id;
        if (previousBaseIds !== newBaseIds) {
          actions.push(`Restore point ${basePoint.id} set as ${tier} base full.`);
        }
      }
    }

    // SyntheticFull sizing is normalized by global base logic (promoteChainBases).
    // Keep this method focused on tier-specific base occupancy only.
  }

  // Ensure a tier retains a base full by promoting the oldest full/synthetic full in that tier,
  // or creating a base full copy when none remains.
  promoteTierBase(
    points: RestorePoint[],
    tier: SOBRTier,
    job: BackupJob,
    chain: BackupChain,
    currentDate: Date,
    fallbackRef?: RestorePoint
  ): string[] {
    const actions: string[] = [];
    const hasBase = points.some(p => this.hasTierData(p, tier) && (p.baseTiers || []).includes(tier));
    if (hasBase) return actions;
    const candidate = this.getOldestFullSizedPoint(points, tier);
    if (candidate) {
      candidate.isTierSeed = true;
      candidate.baseTiers = [...new Set([...(candidate.baseTiers || []), tier])];
      if (candidate.type === 'SyntheticFull' && !candidate.isGFS) {
        const promotedDate = this.parseISODate(candidate.date);
        const elapsedDays = this.state.startDate
          ? (promotedDate.getTime() - this.parseISODate(this.state.startDate).getTime()) / (1000 * 60 * 60 * 24)
          : 0;
        const annualGrowth = (job.annualGrowthRatePct ?? 10) / 100;
        const effectiveSourceTB = (job.sourceDataTB || 1) * Math.pow(1 + annualGrowth, elapsedDays / 365);
        candidate.sizeGB = effectiveSourceTB * 0.5;
        for (const blockId of candidate.referencedBlockIds) {
          const block = this.state.blocks.find(b => b.id === blockId);
          if (block) block.sizeGB = effectiveSourceTB * 0.5;
        }
        actions.push(`Restore point ${candidate.id} promoted as ${tier} base full and resized to full backup size.`);
      } else {
        actions.push(`Restore point ${candidate.id} promoted as ${tier} base full.`);
      }
      return actions;
    }

    if (fallbackRef) {
      const created = this.createTierBaseFull(job, chain, currentDate, tier, fallbackRef);
      actions.push(`Base full ${created.id} created in ${tier} tier.`);
    }
    return actions;
  }

  // For a tier base file, use the oldest full-sized point in the source tier.
  getOldestFullSizedPoint(points: RestorePoint[], tier: SOBRTier): RestorePoint | undefined {
    return points
      .filter(p => this.hasTierData(p, tier) && (p.type === 'Full' || p.type === 'SyntheticFull'))
      .sort((a, b) => this.parseISODate(a.date).getTime() - this.parseISODate(b.date).getTime())[0];
  }

  // Create a base SyntheticFull restore point directly on a SOBR tier (no Performance stage)
  createTierBaseFull(job: BackupJob, chain: BackupChain, date: Date, tier: SOBRTier, representsPoint?: RestorePoint): RestorePoint {
    const elapsedDays = this.state.startDate
      ? (date.getTime() - this.parseISODate(this.state.startDate).getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    const annualGrowth = (job.annualGrowthRatePct ?? 10) / 100;
    const effectiveSourceTB = (job.sourceDataTB || 1) * Math.pow(1 + annualGrowth, elapsedDays / 365);
    const sizeTB = representsPoint?.sizeGB ?? (effectiveSourceTB * 0.5); // base is full-sized, mirrored from represented point when available
    const seedDate = representsPoint?.date || date.toISOString().slice(0, 10);
    const createdDate = date.toISOString().slice(0, 10);
    const rp: RestorePoint = {
      id: `${chain.id}-tierfull-${tier}-${seedDate}-${createdDate}`,
      chainId: chain.id,
      type: 'Full',
      date: seedDate,
      sizeGB: sizeTB,
      referencedBlockIds: [],
      sobrTier: tier,
      // Tier aging starts when this base file is created in that tier.
      sobrTierEnteredAt: createdDate,
      hasPerformanceData: tier === 'Performance',
      hasCapacityData: tier === 'Capacity',
      hasArchiveData: tier === 'Archive',
      capacityCopyCreatedAt: tier === 'Capacity' ? createdDate : undefined,
      capacityMoveFinalizedAt: tier === 'Capacity' ? createdDate : undefined,
      isTierSeed: true,
      baseTiers: [tier],
      representsRestorePointId: representsPoint?.id,
      representsRestorePointDate: representsPoint?.date || seedDate,
      tierMoveHistory: [{ tier, date: createdDate }],
    };
    chain.restorePoints.push(rp);
    this.state.restorePoints.push(rp);
    const block: BlockObject = {
      id: `block-${rp.id}`,
      sizeGB: sizeTB,
      referencedBy: [rp.id],
      storageLocation: job.repositoryId,
    };
    this.state.blocks.push(block);
    rp.referencedBlockIds.push(block.id);
    return rp;
  }

  // Helper: Get SOBR tier usage for a repository
  getSOBRTierUsage(repoId: string): Record<string, number> {
    const repo = this.state.repositories.find(r => r.id === repoId);
    if (!repo || repo.type !== 'SOBR' || !repo.sobrConfig) return {};
    const jobIds = this.state.jobs.filter(j => j.repositoryId === repoId).map(j => j.id);
    const repoPoints = this.state.restorePoints.filter(rp => {
      const chain = this.state.chains.find(c => c.id === rp.chainId);
      return chain && jobIds.includes(chain.jobId);
    });
    // Also include GFS orphan points detached from expired chains.
    const gfsOrphanPoints = this.state.restorePoints.filter(rp =>
      rp.chainId.startsWith('gfs-') && jobIds.some(jid => rp.id.startsWith(jid + '-'))
    );
    const usage: Record<string, number> = { Performance: 0, Capacity: 0, Archive: 0 };
    for (const rp of [...repoPoints, ...gfsOrphanPoints]) {
      if (this.hasTierData(rp, 'Performance')) usage.Performance += this.getRestorePointSizeInTier(rp, 'Performance');
      if (this.hasTierData(rp, 'Capacity')) usage.Capacity += this.getRestorePointSizeInTier(rp, 'Capacity');
      if (this.hasTierData(rp, 'Archive')) usage.Archive += this.getRestorePointSizeInTier(rp, 'Archive');
    }
    return usage;
  }

  // Helper: Should a job run today?
  shouldRunJobToday(job: BackupJob, date: Date): boolean {
    // For demo: run all jobs daily
    return true;
  }

  // Helper: Is today the scheduled SyntheticFull day for this job?
  isSyntheticFullDay(job: BackupJob, date: Date): boolean {
    const syntheticDay = job.schedule?.syntheticFullDay ?? 6; // Default: Saturday
    return date.getUTCDay() === syntheticDay;
  }

  // Helper: Does today match a GFS schedule for this job?
  // All GFS tags land on Saturday (end of period), so monthly = last Saturday of month,
  // yearly = last Saturday of December — they stack on the same restore point.
  isGFSDay(job: BackupJob, date: Date): boolean {
    if (!job.gfsPolicy) return false;
    if (date.getUTCDay() !== 6) return false; // GFS only fires on Saturdays
    if (job.gfsPolicy.weekly) return true; // every Saturday qualifies for weekly
    // Monthly: last Saturday of the month (next Saturday would be in a different month)
    if (job.gfsPolicy.monthly) {
      const nextSat = new Date(date);
      nextSat.setUTCDate(date.getUTCDate() + 7);
      if (nextSat.getUTCMonth() !== date.getUTCMonth()) return true;
    }
    // Yearly: last Saturday of December
    if (job.gfsPolicy.yearly && date.getUTCMonth() === 11) {
      const nextSat = new Date(date);
      nextSat.setUTCDate(date.getUTCDate() + 7);
      if (nextSat.getUTCMonth() !== 11) return true;
    }
    return false;
  }

  // Helper: Create a restore point for a job
  createRestorePoint(job: BackupJob, date: Date, forceType?: RestorePoint['type']): RestorePoint {
    // For demo: always create an incremental except on first run (full) or if forced
    const chain = this.getOrCreateActiveChain(job.id);
    const isFirst = chain.restorePoints.length === 0;
    let type: RestorePoint['type'];
    if (forceType) {
      type = forceType;
    } else {
      type = isFirst ? 'Full' : 'Incremental';
    }
    // Compute effective source size accounting for annual growth since simulation start
    const elapsedDays = this.state.startDate
      ? (date.getTime() - this.parseISODate(this.state.startDate).getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    const annualGrowth = (job.annualGrowthRatePct ?? 10) / 100;
    const effectiveSourceTB = (job.sourceDataTB || 1) * Math.pow(1 + annualGrowth, elapsedDays / 365);
    // Daily change rate drives incremental size only
    const changeRate = (job.dailyChangeRatePct ?? 5) / 100;
    // Apply standard 2:1 (50%) compression ratio
    let rawSizeTB;
    if (type === 'Full') {
      // Full backup: entire source dataset
      rawSizeTB = effectiveSourceTB;
    } else {
      // SyntheticFull and Incremental: SyntheticFull is synthesized from existing blocks —
      // no new data is written beyond the daily change; it only grows to full size when
      // promoted to base full (via retention rollover or SOBR tier offload).
      rawSizeTB = effectiveSourceTB * changeRate;
    }
    const sizeTB = rawSizeTB * 0.5;
    const rp: RestorePoint = {
      id: `${job.id}-${date.toISOString().slice(0, 10)}-${type}`,
      chainId: chain.id,
      type,
      date: date.toISOString().slice(0, 10),
      sizeGB: sizeTB, // Now represents TB
      referencedBlockIds: [],
      isGlobalBase: isFirst && type === 'Full',
      isTierSeed: false,
    };

    this.registerPointInGeneration(job, chain, rp);

    chain.restorePoints.push(rp);
    this.state.restorePoints.push(rp);
    // Stamp initial SOBR tier if this repo is a SOBR
    const repo = this.state.repositories.find(r => r.id === job.repositoryId);
    if (repo?.type === 'SOBR' && repo.sobrConfig) {
      const copyEnabled = this.isCopyEnabled(repo.sobrConfig);
      rp.sobrTier = 'Performance';
      rp.sobrTierEnteredAt = rp.date;
      rp.hasPerformanceData = true;
      rp.hasCapacityData = copyEnabled;
      rp.hasArchiveData = false;
      if (copyEnabled) {
        rp.capacityCopyCreatedAt = rp.date;
      }
      rp.representsRestorePointId = rp.id;
      rp.representsRestorePointDate = rp.date;
      rp.tierMoveHistory = [{ tier: 'Performance', date: rp.date }];
      if (copyEnabled) {
        rp.tierMoveHistory.push({ tier: 'Capacity', date: rp.date });
      }
      if (isFirst && type === 'Full') {
        // First full in Performance acts as the tier seed for that chain.
        rp.isTierSeed = true;
        rp.baseTiers = copyEnabled ? ['Performance', 'Capacity'] : ['Performance'];
      }

      const gen = this.getGenerationForPoint(rp);
      if (gen) {
        if (copyEnabled) {
          this.markGenerationTierEntered(gen, 'Capacity', rp.date, repo);
        }
      }
    }
    // Create new blocks for this restore point
    const block: BlockObject = {
      id: `block-${rp.id}`,
      sizeGB: sizeTB, // Now represents TB
      referencedBy: [rp.id],
      storageLocation: job.repositoryId,
    };
    this.state.blocks.push(block);
    rp.referencedBlockIds.push(block.id);
    return rp;
  }

  // Helper: Get or create the active chain for a job
  getOrCreateActiveChain(jobId: string): BackupChain {
    let chain = this.state.chains.find(c => c.jobId === jobId && c.status === 'Active');
    if (!chain) {
      chain = {
        id: `chain-${jobId}-${this.state.date}`,
        jobId,
        status: 'Active',
        offloadComplete: false,
        restorePoints: [],
      };
      this.state.chains.push(chain);
    }
    return chain;
  }

  // Apply retention and GFS logic
  applyRetentionAndGFS(currentDate: Date): string[] {
    const actions: string[] = [];
    for (const job of this.state.jobs) {
      const retentionCount = job.retention?.restorePoints || 7;
      const repo = this.state.repositories.find(r => r.id === job.repositoryId);
      const isSOBRMoveMode = repo?.type === 'SOBR' && !!repo.sobrConfig && this.isMoveEnabled(repo.sobrConfig);

      for (const generation of (this.state.generations || []).filter(g => g.jobId === job.id)) {
        this.recomputeGenerationDeleteOn(job, generation);
      }

      // Only apply destructive operations to inactive chains
      for (const chain of this.state.chains.filter(c => c.jobId === job.id && c.status === 'Inactive')) {
        const jobRestorePoints = this.state.restorePoints
          .filter(rp => rp.chainId === chain.id)
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        if (jobRestorePoints.length === 0) continue;

        const chainGenerations = (this.state.generations || []).filter(g => g.chainId === chain.id);
        const currentDateIso = this.toISODate(currentDate);

        const allJobRestorePoints = this.state.restorePoints
          .filter(rp => this.state.chains.find(c => c.id === rp.chainId && c.jobId === job.id))
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const lastChainDate = new Date(jobRestorePoints[0].date);
        const countExpired = allJobRestorePoints.length >= retentionCount &&
          lastChainDate < this.parseISODate(allJobRestorePoints[retentionCount - 1].date);
        const slaDays = job.retention?.slaDays || retentionCount;
        const slaExpiry = new Date(currentDate);
        slaExpiry.setUTCDate(slaExpiry.getUTCDate() - slaDays);
        const slaExpired = lastChainDate < slaExpiry;

        const newerChainExists = this.state.chains.some(c => {
          if (c.jobId !== job.id || c.id === chain.id || c.restorePoints.length === 0) return false;
          const candidateNewest = c.restorePoints
            .map(p => p.date)
            .sort()
            .slice(-1)[0];
          return this.parseISODate(candidateNewest).getTime() > this.parseISODate(jobRestorePoints[0].date).getTime();
        });

        if (isSOBRMoveMode) {
          if (!chain.performancePrunedAt) {
            const performanceUnlock = chainGenerations.every(g => this.generationPerformanceImmutableExpired(g, currentDate));
            if (chain.offloadComplete && countExpired && newerChainExists && performanceUnlock) {
              let prunedCount = 0;
              for (const rp of chain.restorePoints) {
                if (!this.hasTierData(rp, 'Performance')) continue;
                rp.baseTiers = (rp.baseTiers || []).filter(t => t !== 'Performance');
                rp.hasPerformanceData = false;
                if (rp.sobrTier === 'Performance') {
                  if (this.hasTierData(rp, 'Capacity')) {
                    rp.sobrTier = 'Capacity';
                  } else if (this.hasTierData(rp, 'Archive')) {
                    rp.sobrTier = 'Archive';
                  }
                  rp.sobrTierEnteredAt = currentDateIso;
                  rp.tierMoveHistory = rp.tierMoveHistory || [];
                  rp.tierMoveHistory.push({ tier: rp.sobrTier || 'Performance', date: currentDateIso });
                }
                prunedCount += 1;
              }

              chain.performancePrunedAt = currentDateIso;
              actions.push(`Chain ${chain.id} pruned from Performance after GEN immutability expiry (${prunedCount} point(s)).`);
            }
          }
        }

        if (!countExpired || !slaExpired) continue;

        const generationGate = chainGenerations.length === 0
          ? true
          : chainGenerations.every(gen => this.generationDeletionUnlocked(gen, chain.restorePoints, currentDate));

        if (!generationGate) {
          continue;
        }

        const chainDeletionReason = chainGenerations.length > 0
          ? `all GENs passed DeleteOn and immutability gates`
          : `retention limit reached`;
        actions.push(`Chain ${chain.id} deleted: ${chainDeletionReason}.`);
        let preservedGfsPoints = 0;
        for (const rp of chain.restorePoints) {
          if (rp.isGFS || rp.isWeeklyGFS || rp.isMonthlyGFS || rp.isYearlyGFS) {
            // Preserve tagged GFS points beyond chain lifetime by detaching from the chain.
            rp.chainId = `gfs-${job.id}`;
            rp.isGlobalBase = false;
            rp.isTierSeed = false;
            preservedGfsPoints += 1;
            continue;
          }

          this.state.restorePoints = this.state.restorePoints.filter(r => r.id !== rp.id);
          for (const blockId of rp.referencedBlockIds) {
            this.state.blocks = this.state.blocks.filter(b => b.id !== blockId);
          }
        }
        if (preservedGfsPoints > 0) {
          actions.push(`Chain ${chain.id}: preserved ${preservedGfsPoints} detached GFS point(s) after chain deletion.`);
        }
        this.state.generations = (this.state.generations || []).filter(g => g.chainId !== chain.id);
        this.state.chains = this.state.chains.filter(c => c.id !== chain.id);
      }

      // GFS retention: enforce max W/M/Y counts per job
      if (job.gfsPolicy) {
        this.applyGFSRetention(job, actions);
      }
    }
    return actions;
  }

  // Delete oldest GFS-tagged points that exceed the configured W/M/Y limits
  applyGFSRetention(job: BackupJob, actions: string[]) {
    if (!job.gfsPolicy) return;

    const deleteOldestGFS = (
      flag: 'isWeeklyGFS' | 'isMonthlyGFS' | 'isYearlyGFS',
      label: string,
      maxKeep: number
    ) => {
      if (!maxKeep) return;
      // All restore points (including detached GFS orphans) tagged with this flag for this job
      const tagged = this.state.restorePoints
        .filter(rp => rp[flag] && (
          // still in a chain belonging to this job, or a detached GFS orphan for this job
          this.state.chains.find(c => c.id === rp.chainId && c.jobId === job.id) ||
          (rp.chainId === `gfs-${job.id}` && rp.id.startsWith(`${job.id}-`))
        ))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()); // newest first
      const excess = tagged.slice(maxKeep);
      for (const rp of excess) {
        actions.push(`${label} GFS point on ${rp.date} untagged (exceeds ${maxKeep} ${label.toLowerCase()} GFS limit).`);
        // Clear this flag; if no GFS flags remain, clear isGFS.
        // Point deletion is GEN-gated and handled by chain retention.
        rp[flag] = false;
        if (!rp.isWeeklyGFS && !rp.isMonthlyGFS && !rp.isYearlyGFS) {
          rp.isGFS = false;
        }
      }
    };

    deleteOldestGFS('isWeeklyGFS', 'Weekly', job.gfsPolicy.weekly);
    deleteOldestGFS('isMonthlyGFS', 'Monthly', job.gfsPolicy.monthly);
    deleteOldestGFS('isYearlyGFS', 'Yearly', job.gfsPolicy.yearly);

    // Detached points that no longer carry any GFS tag are no longer protected.
    const detachedWithoutGfs = this.state.restorePoints.filter(rp =>
      rp.chainId === `gfs-${job.id}` &&
      !rp.isWeeklyGFS &&
      !rp.isMonthlyGFS &&
      !rp.isYearlyGFS
    );
    for (const rp of detachedWithoutGfs) {
      this.state.restorePoints = this.state.restorePoints.filter(r => r.id !== rp.id);
      for (const blockId of rp.referencedBlockIds) {
        this.state.blocks = this.state.blocks.filter(b => b.id !== blockId);
      }
      actions.push(`Detached GFS point ${rp.id} deleted after all GFS tags expired.`);
    }
  }

  // Promote oldest full in each chain to be the chain base, and adjust sizing accordingly
  promoteChainBases(): string[] {
    const actions: string[] = [];

    // Global behavior: exactly one base full per job, regardless of repo type.
    // Type-specific behavior (SOBR tier occupancy) is handled separately in normalizeRepoTierBases.
    for (const job of this.state.jobs) {
      const jobChains = this.state.chains.filter(c => c.jobId === job.id);
      if (jobChains.length === 0) continue;

      const jobPoints = this.state.restorePoints.filter(rp =>
        jobChains.some(c => c.id === rp.chainId)
      );
      if (jobPoints.length === 0) continue;

      const previousBaseId = jobPoints.find(rp => !!rp.isGlobalBase)?.id || '';

      // The base is the oldest Full or SyntheticFull across ALL chains for this job
      // (i.e. across the entire storage tier), regardless of chain active/inactive status.
      const fullPoints = jobPoints
        .filter(rp => rp.type === 'Full' || rp.type === 'SyntheticFull')
        .sort((a, b) => this.parseISODate(a.date).getTime() - this.parseISODate(b.date).getTime());
      if (fullPoints.length === 0) continue;

      const basePoint = fullPoints[0];

      // Clear global base for all job points, then assign only one global base.
      for (const rp of jobPoints) {
        rp.isGlobalBase = false;
        if (rp.type === 'SyntheticFull' && !rp.isGFS) {
          const pointDate = this.parseISODate(rp.date);
          const elapsedDays = this.state.startDate
            ? (pointDate.getTime() - this.parseISODate(this.state.startDate).getTime()) / (1000 * 60 * 60 * 24)
            : 0;
          const annualGrowth = (job.annualGrowthRatePct ?? 10) / 100;
          const effectiveSourceTB = (job.sourceDataTB || 1) * Math.pow(1 + annualGrowth, elapsedDays / 365);
          const incrSizeTB = effectiveSourceTB * (job.dailyChangeRatePct || 5) / 100 * 0.5;
          rp.sizeGB = incrSizeTB;
          for (const blockId of rp.referencedBlockIds) {
            const block = this.state.blocks.find(b => b.id === blockId);
            if (block) block.sizeGB = incrSizeTB;
          }
        }
      }

      basePoint.isGlobalBase = true;
      basePoint.isTierSeed = true;

      if (basePoint.type === 'SyntheticFull' && !basePoint.isGFS) {
        const promotedDate = this.parseISODate(basePoint.date);
        const elapsedDays = this.state.startDate
          ? (promotedDate.getTime() - this.parseISODate(this.state.startDate).getTime()) / (1000 * 60 * 60 * 24)
          : 0;
        const annualGrowth = (job.annualGrowthRatePct ?? 10) / 100;
        const effectiveSourceTB = (job.sourceDataTB || 1) * Math.pow(1 + annualGrowth, elapsedDays / 365);
        const fullSizeTB = effectiveSourceTB * 0.5;
        basePoint.sizeGB = fullSizeTB;
        for (const blockId of basePoint.referencedBlockIds) {
          const block = this.state.blocks.find(b => b.id === blockId);
          if (block) block.sizeGB = fullSizeTB;
        }
      }

      if (previousBaseId !== '' && previousBaseId !== basePoint.id) {
        actions.push(`Job ${job.id}: base full promoted to ${basePoint.id}.`);
      }
    }

    return actions;
  }

  // Get current storage usage by repository
  getStorageUsage() {
    const usage: { [repoId: string]: number } = {};
    for (const repo of this.state.repositories) {
      usage[repo.id] = 0;
    }

    for (const rp of this.state.restorePoints) {
      const job = this.getJobForRestorePoint(rp);
      if (!job) continue;

      const repoId = job.repositoryId;
      let rpTotal = 0;
      if (this.hasTierData(rp, 'Performance')) rpTotal += this.getRestorePointSizeInTier(rp, 'Performance');
      if (this.hasTierData(rp, 'Capacity')) rpTotal += this.getRestorePointSizeInTier(rp, 'Capacity');
      if (this.hasTierData(rp, 'Archive')) rpTotal += this.getRestorePointSizeInTier(rp, 'Archive');
      usage[repoId] = (usage[repoId] || 0) + rpTotal;
    }

    return usage;
  }

  // Get daily explanation of actions
  lastDailyExplanation = '';
  getDailyExplanation() {
    return this.lastDailyExplanation;
  }

  // Get current restore points (for UI)
  getCurrentRestorePoints() {
    return this.state.restorePoints.map(rp => ({
      id: rp.id,
      chainId: rp.chainId,
      generationId: rp.generationId,
      type: rp.type,
      date: rp.date,
      sizeGB: rp.sizeGB,
      isGFS: !!rp.isGFS,
      isGlobalBase: !!rp.isGlobalBase,
      isWeeklyGFS: !!rp.isWeeklyGFS,
      isMonthlyGFS: !!rp.isMonthlyGFS,
      isYearlyGFS: !!rp.isYearlyGFS,
      sobrTier: rp.sobrTier,
      isTierSeed: !!rp.isTierSeed,
      baseTiers: rp.baseTiers,
      representsRestorePointId: rp.representsRestorePointId,
      representsRestorePointDate: rp.representsRestorePointDate,
      tierMoveHistory: rp.tierMoveHistory || [],
      hasPerformanceData: rp.hasPerformanceData,
      hasCapacityData: rp.hasCapacityData,
      hasArchiveData: rp.hasArchiveData,
      capacityCopyCreatedAt: rp.capacityCopyCreatedAt,
      capacityMoveFinalizedAt: rp.capacityMoveFinalizedAt,
    }));
  }

  getCurrentGenerations(currentDate = this.state.date) {
    this.ensureGenerationState();
    const currentMs = this.parseISODate(currentDate).getTime();

    return this.state.generations!
      .map(gen => {
      const points = gen.pointIds
        .map(id => this.state.restorePoints.find(rp => rp.id === id))
        .filter((rp): rp is RestorePoint => !!rp);

      const job = this.state.jobs.find(j => j.id === gen.jobId);
      const repo = job ? this.state.repositories.find(r => r.id === job.repositoryId) : undefined;
      if (!this.usesGenerationLifecycle(repo)) {
        return null;
      }

      const hasPerformanceData = points.some(p => this.hasTierData(p, 'Performance'));
      const hasCapacityData = points.some(p => this.hasTierData(p, 'Capacity'));
      const hasArchiveData = points.some(p => this.hasTierData(p, 'Archive'));

      // Current model: only object tiers participate in GEN lifecycle visibility.
      if (!hasCapacityData && !hasArchiveData) {
        return null;
      }

      const deleteOnReached = currentMs >= this.parseISODate(gen.deleteOn).getTime();
      const performanceLocked = hasPerformanceData && !!gen.performanceImmutableUntil && currentMs < this.parseISODate(gen.performanceImmutableUntil).getTime();
      const capacityLocked = hasCapacityData && !!gen.capacityImmutableUntil && currentMs < this.parseISODate(gen.capacityImmutableUntil).getTime();
      const archiveLocked = hasArchiveData && !!gen.archiveImmutableUntil && currentMs < this.parseISODate(gen.archiveImmutableUntil).getTime();
      const immutabilityLocked = performanceLocked || capacityLocked || archiveLocked;

      const lifecycleState = !deleteOnReached
        ? 'DeleteOn Pending'
        : immutabilityLocked
          ? 'Waiting Immutability'
          : 'Deletable';

      return {
        id: gen.id,
        jobId: gen.jobId,
        chainId: gen.chainId,
        windowStartDate: gen.windowStartDate,
        windowEndDate: gen.windowEndDate,
        deleteOn: gen.deleteOn,
        pointIds: [...gen.pointIds],
        performanceImmutableUntil: gen.performanceImmutableUntil,
        capacityImmutableUntil: gen.capacityImmutableUntil,
        archiveImmutableUntil: gen.archiveImmutableUntil,
        hasPerformanceData,
        hasCapacityData,
        hasArchiveData,
        deleteOnReached,
        performanceLocked,
        capacityLocked,
        archiveLocked,
        immutabilityLocked,
        lifecycleState,
      };
    })
      .filter((gen): gen is NonNullable<typeof gen> => !!gen);
  }
}
