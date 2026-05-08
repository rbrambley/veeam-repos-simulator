// Data model for Veeam Backup Simulator
// This file defines the core interfaces and types for repositories, jobs, chains, restore points, blocks/objects, and retention logic.

export type RepositoryType =
  | 'DAS'
  | 'NAS'
  | 'DedupAppliance'
  | 'ObjectStorage'
  | 'Tape'
  | 'SOBR';

export interface Repository {
  id: string;
  name: string;
  type: RepositoryType;
  capacityTB: number;
  immutabilityDays?: number;
  isImmutable?: boolean;
  supportsBlockClone?: boolean;
  supportsDirectToObject?: boolean;
  sobrConfig?: SOBRConfig;
}

export type SOBRTier = 'Performance' | 'Capacity' | 'Archive';

export interface SOBRConfig {
  performanceCapacityTB: number;   // capacity of Performance tier
  capacityCapacityTB: number;      // capacity of Capacity tier
  archiveCapacityTB: number;       // capacity of Archive tier
  offloadAfterDays: number;        // move from Performance → Capacity after N days in Performance
  archiveAfterDays: number;        // move from Capacity → Archive after N days in Capacity
  generationPeriodDays?: number;   // fixed GEN window, default 10 days
  performanceImmutabilityDays?: number; // Performance-tier immutability window per GEN
  capacityImmutabilityDays?: number; // Capacity-tier immutability window per GEN
  archiveImmutabilityDays?: number; // Archive-tier immutability window per GEN
  hasArchiveTier: boolean;         // whether Archive tier is enabled
  copyEnabled?: boolean;           // copy backup files immediately to Capacity tier
  moveEnabled?: boolean;           // move backup files to Capacity tier after offload age
}

export type BackupJobType =
  | 'ForwardIncremental'
  | 'ReverseIncremental'
  | 'SyntheticFull'
  | 'ActiveFull'
  | 'GFS';

export interface BackupJob {
  id: string;
  name: string;
  type: BackupJobType;
  repositoryId: string;
  sourceDataTB: number; // Size of the source data being backed up
  dailyChangeRatePct: number; // % of source data changed daily (e.g. 5)
  annualGrowthRatePct: number; // % annual data growth (e.g. 10)
  forecastYears: number; // how many years to simulate/forecast
  workingSpacePct?: number; // legacy/optional UI field; Veeam WS uses computeVeeamWorkingSpaceTB bracket formula
  schedule: BackupSchedule;
  retention: RetentionPolicy;
  gfsPolicy?: GFSPolicy;
}

export interface BackupSchedule {
  frequency: 'Daily' | 'Weekly' | 'Monthly';
  timeOfDay: string; // e.g., '02:00'
  syntheticFullDay?: number; // 0=Sun, 1=Mon, ..., 6=Sat. Default 6 (Saturday)
}

export interface RetentionPolicy {
  restorePoints: number;
  slaDays: number;
}

export interface GFSPolicy {
  weekly: number; // weeks to keep
  monthly: number; // months to keep
  yearly: number; // years to keep
}

export type ChainStatus = 'Active' | 'Inactive';

export interface BackupChain {
  id: string;
  jobId: string;
  status: ChainStatus;
  inactiveSince?: string; // ISO date when the chain became inactive
  offloadComplete?: boolean; // true once all chain points are uploaded to Capacity
  offloadCompletedAt?: string; // ISO date when chain offload completed
  performancePrunedAt?: string; // ISO date when chain was pruned from Performance
  restorePoints: RestorePoint[];
}

export interface BackupGeneration {
  id: string;
  jobId: string;
  chainId: string;
  windowStartDate: string;
  windowEndDate: string;
  pointIds: string[];
  deleteOn: string;
  performanceEnteredAt?: string;
  capacityEnteredAt?: string;
  archiveEnteredAt?: string;
  performanceImmutableUntil?: string;
  capacityImmutableUntil?: string;
  archiveImmutableUntil?: string;
}

export type RestorePointType = 'Full' | 'Incremental' | 'SyntheticFull';

export interface TierMoveEvent {
  tier: SOBRTier;
  date: string; // ISO date when point entered this tier
}

export interface RestorePoint {
  id: string;
  chainId: string;
  generationId?: string;
  type: RestorePointType;
  date: string; // ISO date
  sizeGB: number;
  referencedBlockIds: string[];
  isGFS?: boolean;        // true if any GFS tag is applied
  isWeeklyGFS?: boolean;
  isMonthlyGFS?: boolean;
  isYearlyGFS?: boolean;
  sobrTier?: SOBRTier;    // current primary SOBR tier (undefined = non-SOBR repo)
  sobrTierEnteredAt?: string; // ISO date when point entered its current primary tier
  hasPerformanceData?: boolean; // data currently occupies Performance tier
  hasCapacityData?: boolean; // data currently occupies Capacity tier
  hasArchiveData?: boolean; // data currently occupies Archive tier
  capacityCopyCreatedAt?: string; // ISO date when first copied to Capacity tier
  capacityMoveFinalizedAt?: string; // ISO date when move finalized (Performance removed)
  isGlobalBase?: boolean; // true when this restore point is the single job-level base full
  isTierSeed?: boolean; // true when this is a tier initialization full
  baseTiers?: SOBRTier[]; // tiers this restore point is the base full for
  representsRestorePointId?: string; // restore point identity this file represents
  representsRestorePointDate?: string; // creation date of represented restore point
  tierMoveHistory?: TierMoveEvent[];
}

export interface BlockObject {
  id: string;
  sizeGB: number;
  referencedBy: string[]; // restorePoint ids
  storageLocation: string; // repository id or object storage path
}

// Simulation state
export interface SimulationState {
  repositories: Repository[];
  jobs: BackupJob[];
  chains: BackupChain[];
  generations?: BackupGeneration[];
  restorePoints: RestorePoint[];
  blocks: BlockObject[];
  date: string; // current simulation date
  startDate: string; // simulation start date (for growth calculations)
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKING SPACE — VEEAM CALCULATOR PROGRESSIVE TIERED BRACKETS (R-WS-01)
//
// DO NOT MODIFY these brackets without a confirmed change in the Veeam
// Calculator. Transcribed from Veeam Calculator source (verified May 2026).
// Rule R-WS-01: WS = Σ(chunk × rate × compressionRatio) across brackets.
// Default compressionRatio = 0.5 (50% compression assumed by calculator).
//   < 10 TB    → ×1.05
//   10–20 TB   → ×0.66
//   20–100 TB  → ×0.40
//   100–500 TB → ×0.25
//   > 500 TB   → ×0.10
// e.g. 15 TB @ 50% compression = (10×1.05 + 5×0.66) × 0.5 = 6.9 TB
// ─────────────────────────────────────────────────────────────────────────────
export function computeVeeamWorkingSpaceTB(sourceTB: number, compressionRatio = 0.5): number {
  const brackets = [
    { limit: 10,       rate: 1.05 },
    { limit: 20,       rate: 0.66 },
    { limit: 100,      rate: 0.40 },
    { limit: 500,      rate: 0.25 },
    { limit: Infinity, rate: 0.10 },
  ];
  let result = 0;
  let remaining = Math.max(0, sourceTB);
  let prev = 0;
  for (const { limit, rate } of brackets) {
    if (remaining <= 0) break;
    const chunk = Math.min(remaining, limit - prev);
    result += chunk * rate * compressionRatio;
    remaining -= chunk;
    prev = limit;
  }
  return result;
}

