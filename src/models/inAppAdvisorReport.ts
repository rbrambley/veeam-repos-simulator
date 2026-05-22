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
    keyDecisions: string[];
  };
  capacityForecasting: {
    sectionQuestion: string;
    projections: AdvisorProjection[];
    currentEffectiveUsagePct: number;
    daysUntilCapacityEvent?: number;
    year1ToYear3GrowthTB: number;
    year1ToYear3GrowthPct: number;
    capacityRequiredFor20PctHeadroomTB: number;
    capacityRequiredFor30PctHeadroomTB: number;
  };
  jobStrategy: {
    sectionQuestion: string;
    syntheticLoadPct: number;
    gfsDensityPct: number;
    recommendation: string;
  };
  riskRegister: {
    sectionQuestion: string;
    risks: AdvisorRiskItem[];
  };
  actionPlan: {
    sectionQuestion: string;
    actions: Array<{
      id: string;
      priority: AdvisorTimeline;
      riskIds: string[];
      title: string;
      expectedImpact: string;
    }>;
  };
}

export interface InAppCapacityPlanningReport {
  generatedAt: string;
  schemaVersion: string;
  source: InAppAdvisorReport['source'];
  currentEnvelope: {
    sectionQuestion: string;
    currentUsedTB: number;
    currentWorkingSpaceTB: number;
    currentEffectiveTB: number;
    currentEffectiveUsagePct: number;
  };
  demandTrajectory: {
    sectionQuestion: string;
    projections: AdvisorProjection[];
    growthTB: number;
    growthPct: number;
  };
  thresholdCrossings: {
    sectionQuestion: string;
    daysUntilCapacityEvent?: number;
    status: string;
  };
  sizingRecommendation: {
    sectionQuestion: string;
    capacityRequiredFor20PctHeadroomTB: number;
    capacityRequiredFor30PctHeadroomTB: number;
    recommendation: string;
  };
}

export interface InAppProtectionComplianceReport {
  generatedAt: string;
  schemaVersion: string;
  source: InAppAdvisorReport['source'];
  immutabilityPosture: {
    sectionQuestion: string;
    summary: string;
    status: 'strong' | 'partial' | 'weak';
  };
  retentionAndGfs: {
    sectionQuestion: string;
    hasAnyGfs: boolean;
    status: 'configured' | 'gap';
    recommendation: string;
  };
  protectionRisks: {
    sectionQuestion: string;
    risks: AdvisorRiskItem[];
  };
  remediationPlan: {
    sectionQuestion: string;
    actions: Array<{
      id: string;
      priority: AdvisorTimeline;
      riskIds: string[];
      title: string;
      expectedImpact: string;
    }>;
  };
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

function toSource(input: InAppAdvisorInput): InAppAdvisorReport['source'] {
  return {
    scenarioName: input.scenarioName,
    repositoryType: input.repositoryType,
    startDate: input.startDate,
    simulationDate: input.simulationDate,
  };
}

function buildProjections(input: InAppAdvisorInput): AdvisorProjection[] {
  return [1, 2, 3].map((year) => {
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
}

function buildBaseRisks(input: InAppAdvisorInput, currentEffectiveUsagePct: number, currentEffectiveTB: number): AdvisorRiskItem[] {
  const risks: AdvisorRiskItem[] = [];

  if (currentEffectiveUsagePct >= 90) {
    risks.push({
      id: 'CAPACITY-SATURATION',
      title: 'Capacity saturation risk',
      severity: currentEffectiveUsagePct >= 100 ? 'critical' : 'high',
      timeline: 'immediate',
      evidence: `Current effective usage is ${fmt(currentEffectiveUsagePct)}% (${fmt(currentEffectiveTB)} TB of ${fmt(input.capacityTB)} TB).`,
      impact: 'Backup and synthetic operations may fail under constrained capacity.',
      mitigation: 'Increase repository capacity or reduce retention and GFS pressure immediately.',
    });
  } else if (currentEffectiveUsagePct >= 85) {
    risks.push({
      id: 'CAPACITY-PRESSURE',
      title: 'Repository nearing effective limits',
      severity: 'medium',
      timeline: '30-days',
      evidence: `Current effective usage is ${fmt(currentEffectiveUsagePct)}% (${fmt(currentEffectiveTB)} TB of ${fmt(input.capacityTB)} TB).`,
      impact: 'Reduced headroom increases operational and cost risk.',
      mitigation: 'Plan near-term expansion or tune retention and GFS policy.',
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
      mitigation: 'Review retention, offload, and GFS settings against workload lifecycle behavior.',
    });
  }

  if (!input.hasAnyGfs) {
    risks.push({
      id: 'GFS-GAP',
      title: 'No long-term GFS retention configured',
      severity: 'low',
      timeline: '60-days',
      evidence: 'Weekly, monthly, and yearly GFS retention values are all zero.',
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
      mitigation: 'Evaluate SOBR capacity and archive tiers for long-horizon growth control.',
    });
  }

  return risks;
}

function buildActionList(risks: AdvisorRiskItem[]): InAppAdvisorReport['actionPlan']['actions'] {
  const actions = risks
    .slice()
    .sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity])
    .slice(0, 5)
    .map((risk) => ({
      id: `ACT-${risk.id}`,
      priority: risk.timeline,
      riskIds: [risk.id],
      title: risk.title,
      expectedImpact: risk.mitigation,
    }));

  return actions;
}

function projectionRows(projections: AdvisorProjection[]): string {
  return projections.map((projection) => `<tr>
    <td>Year ${projection.year}</td>
    <td>${fmt(projection.plannedCapacityTB)}</td>
    <td>${fmt(projection.plannedPerformanceTierTB)}</td>
    <td>${fmt(projection.plannedCapacityTierTB)}</td>
    <td>${fmt(projection.plannedArchiveTierTB)}</td>
    <td>${fmt(projection.gfsStorageTB)}</td>
    <td>${fmt(projection.syntheticFullTB)}</td>
  </tr>`).join('\n');
}

function htmlShell(title: string, body: string, report: { generatedAt: string; source: { scenarioName: string; simulationDate: string } }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
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
    .question { font-weight: 700; color: #1d3f73; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(title)}</h1>
    <p>Generated: ${esc(report.generatedAt)} | Scenario: ${esc(report.source.scenarioName)} | Date: ${esc(report.source.simulationDate)}</p>
    ${body}
  </div>
</body>
</html>`;
}

export function buildInAppAdvisorReport(input: InAppAdvisorInput): InAppAdvisorReport {
  const projections = buildProjections(input);
  const year1 = projections[0];
  const year3 = projections[2];
  const currentEffectiveTB = input.currentUsedTB + input.currentWorkingSpaceTB;
  const currentEffectiveUsagePct = input.capacityTB > 0 ? (currentEffectiveTB / input.capacityTB) * 100 : 0;
  const growthDeltaTB = Math.max(0, year3.plannedCapacityTB - year1.plannedCapacityTB);
  const growthPct = year1.plannedCapacityTB > 0 ? (growthDeltaTB / year1.plannedCapacityTB) * 100 : 0;
  const risks = buildBaseRisks(input, currentEffectiveUsagePct, currentEffectiveTB);

  const riskScore = risks.length > 0 ? Math.max(...risks.map((risk) => SEVERITY_SCORE[risk.severity])) : 15;
  const riskLevel = toRiskLevel(riskScore);
  const posture: 'stable' | 'constrained' | 'at-risk' = riskLevel === 'Low' ? 'stable' : riskLevel === 'Medium' ? 'constrained' : 'at-risk';
  const daysUntilCapacityEvent = estimateDaysUntilCapacityEvent(currentEffectiveTB, year3.plannedCapacityTB, input.capacityTB);
  const headroom20 = year3.plannedCapacityTB / 0.8;
  const headroom30 = year3.plannedCapacityTB / 0.7;
  const syntheticLoadPct = year3.plannedCapacityTB > 0 ? (year3.syntheticFullTB / year3.plannedCapacityTB) * 100 : 0;
  const gfsDensityPct = year3.plannedCapacityTB > 0 ? (year3.gfsStorageTB / year3.plannedCapacityTB) * 100 : 0;

  const actions = buildActionList(risks);
  if (!actions.some((action) => action.id.includes('CAPACITY'))) {
    actions.push({
      id: 'ACT-HEADROOM',
      priority: '60-days',
      riskIds: [],
      title: 'Establish a headroom target for Year-3 demand',
      expectedImpact: `Plan repository envelope to ${fmt(headroom20)}-${fmt(headroom30)} TB for 20-30% free capacity.`,
    });
  }

  const recommendation = syntheticLoadPct >= 25
    ? 'Synthetic load is high: tune full cadence or retention to reduce chain churn pressure.'
    : gfsDensityPct >= 20
      ? 'GFS density is high: validate long-term retention tiers and archive economics.'
      : 'Job profile is balanced: maintain current cadence and monitor quarterly drift.';

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: '2.0.0',
    source: toSource(input),
    executiveSummary: {
      riskLevel,
      posture,
      keyDecisions: [
        `Do we need immediate capacity action? ${daysUntilCapacityEvent !== undefined && daysUntilCapacityEvent <= 90 ? 'Yes, within 90 days.' : 'No immediate saturation signal.'}`,
        `Should we re-tune policy now? ${input.policyHighestPriority === 'high' || input.policyHighestPriority === 'medium' ? 'Yes, policy risk is elevated.' : 'Not urgent.'}`,
        `Is protection posture acceptable? ${input.immutabilitySummary.toLowerCase().includes('0d') || input.immutabilitySummary.toLowerCase().includes('not configured') ? 'No, immutability needs hardening.' : 'Yes, baseline controls are present.'}`,
      ],
    },
    capacityForecasting: {
      sectionQuestion: 'When do we run out of safe headroom and what envelope should we target?',
      projections,
      currentEffectiveUsagePct,
      daysUntilCapacityEvent,
      year1ToYear3GrowthTB: growthDeltaTB,
      year1ToYear3GrowthPct: growthPct,
      capacityRequiredFor20PctHeadroomTB: headroom20,
      capacityRequiredFor30PctHeadroomTB: headroom30,
    },
    jobStrategy: {
      sectionQuestion: 'Which backup policy lever is the highest-value tuning target?',
      syntheticLoadPct,
      gfsDensityPct,
      recommendation,
    },
    riskRegister: {
      sectionQuestion: 'Which risks are active right now, with direct evidence?',
      risks,
    },
    actionPlan: {
      sectionQuestion: 'What are the minimum actions for the next 30, 60, and 90 days?',
      actions,
    },
  };
}

export function buildInAppCapacityPlanningReport(input: InAppAdvisorInput): InAppCapacityPlanningReport {
  const projections = buildProjections(input);
  const year1 = projections[0];
  const year3 = projections[2];
  const currentEffectiveTB = input.currentUsedTB + input.currentWorkingSpaceTB;
  const currentEffectiveUsagePct = input.capacityTB > 0 ? (currentEffectiveTB / input.capacityTB) * 100 : 0;
  const growthTB = Math.max(0, year3.plannedCapacityTB - year1.plannedCapacityTB);
  const growthPct = year1.plannedCapacityTB > 0 ? (growthTB / year1.plannedCapacityTB) * 100 : 0;
  const daysUntilCapacityEvent = estimateDaysUntilCapacityEvent(currentEffectiveTB, year3.plannedCapacityTB, input.capacityTB);
  const headroom20 = year3.plannedCapacityTB / 0.8;
  const headroom30 = year3.plannedCapacityTB / 0.7;

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    source: toSource(input),
    currentEnvelope: {
      sectionQuestion: 'How much effective capacity are we consuming today?',
      currentUsedTB: input.currentUsedTB,
      currentWorkingSpaceTB: input.currentWorkingSpaceTB,
      currentEffectiveTB,
      currentEffectiveUsagePct,
    },
    demandTrajectory: {
      sectionQuestion: 'How quickly does demand grow from Year-1 to Year-3?',
      projections,
      growthTB,
      growthPct,
    },
    thresholdCrossings: {
      sectionQuestion: 'When is the first expected capacity event under current policy?',
      daysUntilCapacityEvent,
      status: daysUntilCapacityEvent === undefined
        ? 'No event projected in modeled window.'
        : daysUntilCapacityEvent === 0
          ? 'Capacity event already reached.'
          : `Capacity event projected in about ${daysUntilCapacityEvent} days.`,
    },
    sizingRecommendation: {
      sectionQuestion: 'What capacity range preserves safe operating headroom?',
      capacityRequiredFor20PctHeadroomTB: headroom20,
      capacityRequiredFor30PctHeadroomTB: headroom30,
      recommendation: `Target ${fmt(headroom20)}-${fmt(headroom30)} TB to keep 20-30% free capacity at Year-3 demand.`,
    },
  };
}

export function buildInAppProtectionComplianceReport(input: InAppAdvisorInput): InAppProtectionComplianceReport {
  const currentEffectiveTB = input.currentUsedTB + input.currentWorkingSpaceTB;
  const currentEffectiveUsagePct = input.capacityTB > 0 ? (currentEffectiveTB / input.capacityTB) * 100 : 0;
  const allRisks = buildBaseRisks(input, currentEffectiveUsagePct, currentEffectiveTB);
  const protectionRisks = allRisks.filter((risk) => risk.id === 'IMMUTABILITY-GAP' || risk.id === 'GFS-GAP' || risk.id === 'POLICY-RISK');
  const actions = buildActionList(protectionRisks);

  const summaryLower = input.immutabilitySummary.toLowerCase();
  const status: 'strong' | 'partial' | 'weak' = summaryLower.includes('not configured') || summaryLower.includes(' 0d')
    ? 'weak'
    : input.policyHighestPriority === 'high' || input.policyHighestPriority === 'medium'
      ? 'partial'
      : 'strong';

  const gfsStatus: 'configured' | 'gap' = input.hasAnyGfs ? 'configured' : 'gap';

  if (actions.length === 0) {
    actions.push({
      id: 'ACT-PROTECT-BASELINE',
      priority: '60-days',
      riskIds: [],
      title: 'Maintain current protection baseline',
      expectedImpact: 'No immediate protection gap detected; keep periodic validation cadence.',
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    source: toSource(input),
    immutabilityPosture: {
      sectionQuestion: 'Is immutability coverage strong enough for ransomware resilience?',
      summary: input.immutabilitySummary,
      status,
    },
    retentionAndGfs: {
      sectionQuestion: 'Does retention design include long-horizon recovery points?',
      hasAnyGfs: input.hasAnyGfs,
      status: gfsStatus,
      recommendation: input.hasAnyGfs
        ? 'GFS is configured; verify tier placement economics quarterly.'
        : 'Configure weekly, monthly, or yearly GFS points for long-horizon retention.',
    },
    protectionRisks: {
      sectionQuestion: 'Which protection and compliance gaps are currently active?',
      risks: protectionRisks,
    },
    remediationPlan: {
      sectionQuestion: 'What targeted remediation steps close these protection gaps?',
      actions,
    },
  };
}

export function renderInAppAdvisorReportHtml(report: InAppAdvisorReport): string {
  const riskRows = report.riskRegister.risks.map((risk) => `<tr>
    <td>${esc(risk.id)}</td>
    <td>${esc(risk.severity.toUpperCase())}</td>
    <td>${esc(risk.timeline)}</td>
    <td>${esc(risk.title)}</td>
    <td>${esc(risk.evidence)}</td>
    <td>${esc(risk.mitigation)}</td>
  </tr>`).join('\n');

  const actionRows = report.actionPlan.actions.map((action) => `<li><strong>${esc(action.priority)}</strong> - ${esc(action.title)} [Risks: ${esc(action.riskIds.join(', ') || 'General')}]. ${esc(action.expectedImpact)}</li>`).join('\n');

  const body = `
    <section class="card">
      <h2>Executive Summary</h2>
      <p><strong>Risk:</strong> ${esc(report.executiveSummary.riskLevel)} | <strong>Posture:</strong> ${esc(report.executiveSummary.posture)}</p>
      <ul>${report.executiveSummary.keyDecisions.map((decision) => `<li>${esc(decision)}</li>`).join('')}</ul>
    </section>

    <section class="card">
      <h2>Capacity Forecasting</h2>
      <p class="question">Q: ${esc(report.capacityForecasting.sectionQuestion)}</p>
      <p><strong>Effective usage:</strong> ${fmt(report.capacityForecasting.currentEffectiveUsagePct)}%</p>
      <p><strong>Days to event:</strong> ${report.capacityForecasting.daysUntilCapacityEvent ?? 'No event in window'}</p>
      <p><strong>Y1 to Y3 growth:</strong> ${fmt(report.capacityForecasting.year1ToYear3GrowthTB)} TB (${fmt(report.capacityForecasting.year1ToYear3GrowthPct)}%)</p>
      <p><strong>Headroom target:</strong> ${fmt(report.capacityForecasting.capacityRequiredFor20PctHeadroomTB)}-${fmt(report.capacityForecasting.capacityRequiredFor30PctHeadroomTB)} TB</p>
      <table>
        <thead>
          <tr><th>Year</th><th>Planned TB</th><th>Performance TB</th><th>Capacity TB</th><th>Archive TB</th><th>GFS TB</th><th>Synthetic TB</th></tr>
        </thead>
        <tbody>${projectionRows(report.capacityForecasting.projections)}</tbody>
      </table>
    </section>

    <section class="card">
      <h2>Job Strategy</h2>
      <p class="question">Q: ${esc(report.jobStrategy.sectionQuestion)}</p>
      <p><strong>Synthetic load:</strong> ${fmt(report.jobStrategy.syntheticLoadPct)}%</p>
      <p><strong>GFS density:</strong> ${fmt(report.jobStrategy.gfsDensityPct)}%</p>
      <p><strong>Recommendation:</strong> ${esc(report.jobStrategy.recommendation)}</p>
    </section>

    <section class="card">
      <h2>Risk Register</h2>
      <p class="question">Q: ${esc(report.riskRegister.sectionQuestion)}</p>
      <table>
        <thead>
          <tr><th>ID</th><th>Severity</th><th>Timeline</th><th>Risk</th><th>Evidence</th><th>Mitigation</th></tr>
        </thead>
        <tbody>${riskRows || '<tr><td colspan="6">No active risks detected.</td></tr>'}</tbody>
      </table>
    </section>

    <section class="card">
      <h2>Action Plan</h2>
      <p class="question">Q: ${esc(report.actionPlan.sectionQuestion)}</p>
      <ul>${actionRows}</ul>
    </section>
  `;

  return htmlShell('Storage Planning Advisor Report', body, report);
}

export function renderInAppCapacityPlanningReportHtml(report: InAppCapacityPlanningReport): string {
  const body = `
    <section class="card">
      <h2>Current Envelope</h2>
      <p class="question">Q: ${esc(report.currentEnvelope.sectionQuestion)}</p>
      <p><strong>Used:</strong> ${fmt(report.currentEnvelope.currentUsedTB)} TB | <strong>Working:</strong> ${fmt(report.currentEnvelope.currentWorkingSpaceTB)} TB | <strong>Effective:</strong> ${fmt(report.currentEnvelope.currentEffectiveTB)} TB (${fmt(report.currentEnvelope.currentEffectiveUsagePct)}%)</p>
    </section>

    <section class="card">
      <h2>Demand Trajectory</h2>
      <p class="question">Q: ${esc(report.demandTrajectory.sectionQuestion)}</p>
      <p><strong>Y1 to Y3 growth:</strong> ${fmt(report.demandTrajectory.growthTB)} TB (${fmt(report.demandTrajectory.growthPct)}%)</p>
      <table>
        <thead>
          <tr><th>Year</th><th>Planned TB</th><th>Performance TB</th><th>Capacity TB</th><th>Archive TB</th><th>GFS TB</th><th>Synthetic TB</th></tr>
        </thead>
        <tbody>${projectionRows(report.demandTrajectory.projections)}</tbody>
      </table>
    </section>

    <section class="card">
      <h2>Threshold Crossings</h2>
      <p class="question">Q: ${esc(report.thresholdCrossings.sectionQuestion)}</p>
      <p>${esc(report.thresholdCrossings.status)}</p>
    </section>

    <section class="card">
      <h2>Sizing Recommendation</h2>
      <p class="question">Q: ${esc(report.sizingRecommendation.sectionQuestion)}</p>
      <p><strong>20% free target:</strong> ${fmt(report.sizingRecommendation.capacityRequiredFor20PctHeadroomTB)} TB</p>
      <p><strong>30% free target:</strong> ${fmt(report.sizingRecommendation.capacityRequiredFor30PctHeadroomTB)} TB</p>
      <p><strong>Recommendation:</strong> ${esc(report.sizingRecommendation.recommendation)}</p>
    </section>
  `;

  return htmlShell('Capacity Planning Report', body, report);
}

export function renderInAppProtectionComplianceReportHtml(report: InAppProtectionComplianceReport): string {
  const riskRows = report.protectionRisks.risks.map((risk) => `<tr>
    <td>${esc(risk.id)}</td>
    <td>${esc(risk.severity.toUpperCase())}</td>
    <td>${esc(risk.timeline)}</td>
    <td>${esc(risk.title)}</td>
    <td>${esc(risk.evidence)}</td>
    <td>${esc(risk.mitigation)}</td>
  </tr>`).join('\n');

  const actionRows = report.remediationPlan.actions.map((action) => `<li><strong>${esc(action.priority)}</strong> - ${esc(action.title)} [Risks: ${esc(action.riskIds.join(', ') || 'General')}]. ${esc(action.expectedImpact)}</li>`).join('\n');

  const body = `
    <section class="card">
      <h2>Immutability Posture</h2>
      <p class="question">Q: ${esc(report.immutabilityPosture.sectionQuestion)}</p>
      <p><strong>Status:</strong> ${esc(report.immutabilityPosture.status.toUpperCase())}</p>
      <p>${esc(report.immutabilityPosture.summary)}</p>
    </section>

    <section class="card">
      <h2>Retention and GFS Coverage</h2>
      <p class="question">Q: ${esc(report.retentionAndGfs.sectionQuestion)}</p>
      <p><strong>GFS configured:</strong> ${report.retentionAndGfs.hasAnyGfs ? 'Yes' : 'No'}</p>
      <p><strong>Status:</strong> ${esc(report.retentionAndGfs.status.toUpperCase())}</p>
      <p><strong>Recommendation:</strong> ${esc(report.retentionAndGfs.recommendation)}</p>
    </section>

    <section class="card">
      <h2>Protection Risks</h2>
      <p class="question">Q: ${esc(report.protectionRisks.sectionQuestion)}</p>
      <table>
        <thead>
          <tr><th>ID</th><th>Severity</th><th>Timeline</th><th>Risk</th><th>Evidence</th><th>Mitigation</th></tr>
        </thead>
        <tbody>${riskRows || '<tr><td colspan="6">No active protection risks detected.</td></tr>'}</tbody>
      </table>
    </section>

    <section class="card">
      <h2>Remediation Plan</h2>
      <p class="question">Q: ${esc(report.remediationPlan.sectionQuestion)}</p>
      <ul>${actionRows}</ul>
    </section>
  `;

  return htmlShell('Protection and Compliance Report', body, report);
}
