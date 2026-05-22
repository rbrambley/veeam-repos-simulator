import { computeSimulatorPlanned, ScenarioConfig } from './plannedCapacityCalculator';

export type AdvisorSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AdvisorTimeline = 'immediate' | '30-days' | '60-days' | '90-days';
export type AdvisorRiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export interface AdvisorRiskItem {
  id: string;
  title: string;
  severity: AdvisorSeverity;
  timeline: AdvisorTimeline;
  evidence: string;
  impact: string;
  mitigation: string;
}

export interface AdvisorProjection {
  year: number;
  plannedCapacityTB: number;
  plannedPerformanceTierTB: number;
  plannedCapacityTierTB: number;
  plannedArchiveTierTB: number;
  gfsStorageTB: number;
  fullTB: number;
  incrementalTB: number;
  syntheticFullTB: number;
}

export interface InAppAdvisorReport {
  generatedAt: string;
  schemaVersion: string;
  source: {
    scenarioName: string;
    repositoryType: 'DAS' | 'SOBR';
    startDate: string;
    simulationDate: string;
  };
  executiveSummary: {
    riskLevel: AdvisorRiskLevel;
    posture: 'stable' | 'constrained' | 'at-risk';
    narrative: string;
    next30_60_90: {
      days30: string[];
      days60: string[];
      days90: string[];
    };
  };
  capacityForecasting: {
    currentUsedTB: number;
    currentWorkingSpaceTB: number;
    currentEffectiveUsagePct: number;
    projections: AdvisorProjection[];
    growthDeltaTB: number;
    growthPct: number;
    targetHeadroom: {
      minFreePct: number;
      maxFreePct: number;
      capacityRequiredFor20PctHeadroomTB: number;
      capacityRequiredFor30PctHeadroomTB: number;
    };
    daysUntilCapacityEvent?: number;
  };
  riskRegister: AdvisorRiskItem[];
  actionPlan: {
    actions: Array<{
      id: string;
      priority: AdvisorTimeline;
      title: string;
      rationale: string;
      expectedImpact: string;
    }>;
  };
}

export interface InAppAdvisorInput {
  scenarioName: string;
  startDate: string;
  simulationDate: string;
  repositoryType: 'DAS' | 'SOBR';
  scenarioConfig: ScenarioConfig;
  currentUsedTB: number;
  currentWorkingSpaceTB: number;
  capacityTB: number;
  policyHighestPriority: 'high' | 'medium' | 'low' | 'info';
  immutabilitySummary: string;
  hasAnyGfs: boolean;
}

const SEVERITY_SCORE: Record<AdvisorSeverity, number> = {
  low: 20,
  medium: 45,
  high: 70,
  critical: 90,
};

function fmt(value: number): string {
  return value.toFixed(2);
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;');
}

function toRiskLevel(score: number): AdvisorRiskLevel {
  if (score >= 85) return 'Critical';
  if (score >= 65) return 'High';
  if (score >= 40) return 'Medium';
  return 'Low';
}

function estimateDaysUntilCapacityEvent(currentEffectiveTB: number, year3PlannedTB: number, capacityTB: number): number | undefined {
  if (!(capacityTB > 0)) return undefined;
  if (currentEffectiveTB >= capacityTB) return 0;
  if (year3PlannedTB <= currentEffectiveTB) return undefined;

  const ratioToCapacity = (capacityTB - currentEffectiveTB) / (year3PlannedTB - currentEffectiveTB);
  const clampedRatio = Math.max(0, Math.min(1, ratioToCapacity));
  return Math.ceil(clampedRatio * 3 * 365);
}

export function buildInAppAdvisorReport(input: InAppAdvisorInput): InAppAdvisorReport {
  const projections: AdvisorProjection[] = [1, 2, 3].map((year) => {
    const result = computeSimulatorPlanned(input.scenarioConfig, input.startDate, year, 'reverse', year * 365);
    return {
      year,
      plannedCapacityTB: result.plannedCapacityTB,
      plannedPerformanceTierTB: result.plannedPerformanceTierTB,
      plannedCapacityTierTB: result.plannedCapacityTierTB,
      plannedArchiveTierTB: result.plannedArchiveTierTB,
      gfsStorageTB: result.gfsStorageTB,
      fullTB: result.fileTypeFullTB,
      incrementalTB: result.fileTypeIncrementalTB,
      syntheticFullTB: result.fileTypeSyntheticFullTB,
    };
  });

  const currentEffectiveTB = input.currentUsedTB + input.currentWorkingSpaceTB;
  const currentEffectiveUsagePct = input.capacityTB > 0 ? (currentEffectiveTB / input.capacityTB) * 100 : 0;
  const year1 = projections[0];
  const year3 = projections[2];
  const growthDeltaTB = Math.max(0, year3.plannedCapacityTB - year1.plannedCapacityTB);
  const growthPct = year1.plannedCapacityTB > 0 ? (growthDeltaTB / year1.plannedCapacityTB) * 100 : 0;

  const risks: AdvisorRiskItem[] = [];

  if (currentEffectiveUsagePct >= 90) {
    risks.push({
      id: 'CAPACITY-SATURATION',
      title: 'Capacity saturation risk',
      severity: currentEffectiveUsagePct >= 100 ? 'critical' : 'high',
      timeline: 'immediate',
      evidence: `Current effective usage is ${fmt(currentEffectiveUsagePct)}% (${fmt(currentEffectiveTB)} TB of ${fmt(input.capacityTB)} TB).`,
      impact: 'Backup and synthetic operations may fail under constrained capacity.',
      mitigation: 'Increase repository capacity or reduce retention/GFS pressure immediately.',
    });
  } else if (currentEffectiveUsagePct >= 85) {
    risks.push({
      id: 'CAPACITY-PRESSURE',
      title: 'Repository nearing effective limits',
      severity: 'medium',
      timeline: '30-days',
      evidence: `Current effective usage is ${fmt(currentEffectiveUsagePct)}% (${fmt(currentEffectiveTB)} TB of ${fmt(input.capacityTB)} TB).`,
      impact: 'Reduced headroom increases operational and cost risk.',
      mitigation: 'Plan near-term expansion or tune retention/GFS policy.',
    });
  }

  if (input.policyHighestPriority === 'high' || input.policyHighestPriority === 'medium') {
    risks.push({
      id: 'POLICY-RISK',
      title: 'Policy risk surfaced by simulation insights',
      severity: input.policyHighestPriority === 'high' ? 'high' : 'medium',
      timeline: input.policyHighestPriority === 'high' ? 'immediate' : '30-days',
      evidence: `Policy insight priority is ${input.policyHighestPriority.toUpperCase()} in the current simulation snapshot.`,
      impact: 'Current policy settings may increase lifecycle friction or capacity pressure.',
      mitigation: 'Review retention/offload/GFS settings and apply recommendation set from policy insights.',
    });
  }

  if (!input.hasAnyGfs) {
    risks.push({
      id: 'GFS-GAP',
      title: 'No long-term GFS retention configured',
      severity: 'low',
      timeline: '60-days',
      evidence: 'Weekly/monthly/yearly GFS retention values are all zero.',
      impact: 'Long-term retention and compliance snapshots may be insufficient.',
      mitigation: 'Enable GFS if long-term retention or auditability is required.',
    });
  }

  if (input.immutabilitySummary.includes(' 0d') || input.immutabilitySummary.toLowerCase().includes('not configured')) {
    risks.push({
      id: 'IMMUTABILITY-GAP',
      title: 'Immutability posture gap',
      severity: 'medium',
      timeline: '30-days',
      evidence: input.immutabilitySummary,
      impact: 'Ransomware resilience and compliance posture may be weaker than desired.',
      mitigation: 'Set minimum 7-14 day immutability windows based on recovery objectives.',
    });
  }

  if (input.repositoryType === 'DAS') {
    risks.push({
      id: 'SINGLE-REPO-DEPENDENCY',
      title: 'Single-tier dependency',
      severity: 'low',
      timeline: '90-days',
      evidence: 'Repository type is DAS with no multi-tier offload path in this scenario.',
      impact: 'Growth and cost optimization options are limited compared to tiered architectures.',
      mitigation: 'Evaluate SOBR capacity/archive tiers for long-horizon growth control.',
    });
  }

  const riskScore = risks.length > 0
    ? Math.max(...risks.map((risk) => SEVERITY_SCORE[risk.severity]))
    : 15;

  const riskLevel = toRiskLevel(riskScore);
  const posture: 'stable' | 'constrained' | 'at-risk' = riskLevel === 'Low'
    ? 'stable'
    : riskLevel === 'Medium'
      ? 'constrained'
      : 'at-risk';

  const targetHeadroom = {
    minFreePct: 20,
    maxFreePct: 30,
    capacityRequiredFor20PctHeadroomTB: year3.plannedCapacityTB / 0.8,
    capacityRequiredFor30PctHeadroomTB: year3.plannedCapacityTB / 0.7,
  };

  const actions = [...risks]
    .sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity])
    .slice(0, 5)
    .map((risk) => ({
      id: `ACT-${risk.id}`,
      priority: risk.timeline,
      title: risk.title,
      rationale: risk.evidence,
      expectedImpact: risk.mitigation,
    }));

  if (!actions.some((action) => action.id.includes('CAPACITY'))) {
    actions.push({
      id: 'ACT-HEADROOM',
      priority: '60-days',
      title: 'Establish capacity headroom target',
      rationale: 'Year-3 projection should retain 20-30% free capacity to reduce operational risk.',
      expectedImpact: `Plan capacity envelope to ${fmt(targetHeadroom.capacityRequiredFor20PctHeadroomTB)}-${fmt(targetHeadroom.capacityRequiredFor30PctHeadroomTB)} TB.`,
    });
  }

  const next30 = actions.filter((action) => action.priority === 'immediate' || action.priority === '30-days').map((action) => action.expectedImpact);
  const next60 = actions.filter((action) => action.priority === '60-days').map((action) => action.expectedImpact);
  const next90 = actions.filter((action) => action.priority === '90-days').map((action) => action.expectedImpact);

  const report: InAppAdvisorReport = {
    generatedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    source: {
      scenarioName: input.scenarioName,
      repositoryType: input.repositoryType,
      startDate: input.startDate,
      simulationDate: input.simulationDate,
    },
    executiveSummary: {
      riskLevel,
      posture,
      narrative: `Environment is currently ${posture}. Effective usage is ${fmt(currentEffectiveUsagePct)}%, Year-3 planned footprint is ${fmt(year3.plannedCapacityTB)} TB, and projected growth from Year-1 is ${fmt(growthPct)}%.`,
      next30_60_90: {
        days30: next30.length > 0 ? next30 : ['Validate baseline capacity and confirm immediate policy constraints.'],
        days60: next60,
        days90: next90,
      },
    },
    capacityForecasting: {
      currentUsedTB: input.currentUsedTB,
      currentWorkingSpaceTB: input.currentWorkingSpaceTB,
      currentEffectiveUsagePct,
      projections,
      growthDeltaTB,
      growthPct,
      targetHeadroom,
      daysUntilCapacityEvent: estimateDaysUntilCapacityEvent(currentEffectiveTB, year3.plannedCapacityTB, input.capacityTB),
    },
    riskRegister: risks,
    actionPlan: {
      actions,
    },
  };

  return report;
}

export function renderInAppAdvisorReportHtml(report: InAppAdvisorReport): string {
  const projectionRows = report.capacityForecasting.projections.map((projection) => `<tr>
    <td>Year ${projection.year}</td>
    <td>${fmt(projection.plannedCapacityTB)}</td>
    <td>${fmt(projection.plannedPerformanceTierTB)}</td>
    <td>${fmt(projection.plannedCapacityTierTB)}</td>
    <td>${fmt(projection.plannedArchiveTierTB)}</td>
    <td>${fmt(projection.gfsStorageTB)}</td>
    <td>${fmt(projection.syntheticFullTB)}</td>
  </tr>`).join('\n');

  const riskRows = report.riskRegister.map((risk) => `<tr>
    <td>${esc(risk.id)}</td>
    <td>${esc(risk.severity.toUpperCase())}</td>
    <td>${esc(risk.timeline)}</td>
    <td>${esc(risk.title)}</td>
    <td>${esc(risk.evidence)}</td>
    <td>${esc(risk.mitigation)}</td>
  </tr>`).join('\n');

  const actionRows = report.actionPlan.actions.map((action) => `<li><strong>${esc(action.priority)}</strong> - ${esc(action.title)}. ${esc(action.expectedImpact)}</li>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Storage Planning Advisor Report</title>
  <style>
    body { font-family: "Segoe UI", Tahoma, sans-serif; margin: 0; background: #f4f8ff; color: #10243d; }
    .wrap { max-width: 1160px; margin: 0 auto; padding: 20px 16px 36px; }
    .card { background: #fff; border: 1px solid #d7e3f2; border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
    h1 { margin: 0 0 8px; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 6px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #e6edf8; padding: 8px; font-size: 13px; text-align: left; vertical-align: top; }
    th { background: #f2f7ff; }
    ul { margin: 6px 0 0 18px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Storage Planning Advisor Report</h1>
    <p>Generated: ${esc(report.generatedAt)} | Scenario: ${esc(report.source.scenarioName)} | Date: ${esc(report.source.simulationDate)}</p>

    <section class="card">
      <h2>Executive Summary</h2>
      <p><strong>Risk:</strong> ${esc(report.executiveSummary.riskLevel)} | <strong>Posture:</strong> ${esc(report.executiveSummary.posture)}</p>
      <p>${esc(report.executiveSummary.narrative)}</p>
      <p><strong>Next 30 days:</strong> ${esc(report.executiveSummary.next30_60_90.days30.join(' | '))}</p>
      <p><strong>Next 60 days:</strong> ${esc(report.executiveSummary.next30_60_90.days60.join(' | ') || 'No additional 60-day actions')}</p>
      <p><strong>Next 90 days:</strong> ${esc(report.executiveSummary.next30_60_90.days90.join(' | ') || 'No additional 90-day actions')}</p>
    </section>

    <section class="card">
      <h2>Capacity Forecasting</h2>
      <p><strong>Current used:</strong> ${fmt(report.capacityForecasting.currentUsedTB)} TB | <strong>Working space:</strong> ${fmt(report.capacityForecasting.currentWorkingSpaceTB)} TB | <strong>Effective usage:</strong> ${fmt(report.capacityForecasting.currentEffectiveUsagePct)}%</p>
      <p><strong>Year1->Year3 growth:</strong> ${fmt(report.capacityForecasting.growthDeltaTB)} TB (${fmt(report.capacityForecasting.growthPct)}%)</p>
      <p><strong>Target headroom (20-30% free):</strong> ${fmt(report.capacityForecasting.targetHeadroom.capacityRequiredFor20PctHeadroomTB)}-${fmt(report.capacityForecasting.targetHeadroom.capacityRequiredFor30PctHeadroomTB)} TB</p>
      <table>
        <thead>
          <tr>
            <th>Year</th>
            <th>Planned TB</th>
            <th>Performance TB</th>
            <th>Capacity Tier TB</th>
            <th>Archive Tier TB</th>
            <th>GFS TB</th>
            <th>Synthetic Full TB</th>
          </tr>
        </thead>
        <tbody>
          ${projectionRows}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Risk Register</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Severity</th>
            <th>Timeline</th>
            <th>Risk</th>
            <th>Evidence</th>
            <th>Mitigation</th>
          </tr>
        </thead>
        <tbody>
          ${riskRows || '<tr><td colspan="6">No active risks detected.</td></tr>'}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>What You Should Do Next</h2>
      <ul>
        ${actionRows}
      </ul>
    </section>
  </div>
</body>
</html>`;
}
