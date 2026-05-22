export function normalizeForecastYears(value: number | null | undefined, fallback: number = 1): number {
  const resolvedFallback = Math.max(1, Math.floor(Number.isFinite(fallback) ? fallback : 1));
  const numericValue = Number.isFinite(value as number) ? Number(value) : resolvedFallback;
  return Math.max(1, Math.floor(numericValue));
}

type GfsForecastPolicy = {
  weekly?: number;
  monthly?: number;
  yearly?: number;
};

/**
 * Converts GFS retention cardinalities into a minimum forecast horizon in years.
 * Weekly and monthly values are treated as counts in their native units,
 * not as years.
 */
export function minimumForecastYearsFromGfs(policy?: GfsForecastPolicy): number {
  const weekly = Math.max(0, Math.floor(Number(policy?.weekly ?? 0)));
  const monthly = Math.max(0, Math.floor(Number(policy?.monthly ?? 0)));
  const yearly = Math.max(0, Math.floor(Number(policy?.yearly ?? 0)));

  const weeklyYears = weekly / 52;
  const monthlyYears = monthly / 12;
  const requiredYears = Math.max(weeklyYears, monthlyYears, yearly);

  return Math.max(1, Math.ceil(requiredYears));
}

/**
 * Reconciles forecast years when GFS policy changes.
 *
 * Behavior:
 * - If the current forecast was exactly the previous auto-minimum, treat it as
 *   auto-managed and follow the new minimum (up or down).
 * - If the current forecast is above the previous auto-minimum, treat it as
 *   user-chosen and only clamp upward when the new minimum exceeds it.
 */
export function reconcileForecastYearsWithGfs(
  currentForecastYears: number,
  previousPolicy?: GfsForecastPolicy,
  nextPolicy?: GfsForecastPolicy,
): number {
  const current = normalizeForecastYears(currentForecastYears);
  const previousMinimum = minimumForecastYearsFromGfs(previousPolicy);
  const nextMinimum = minimumForecastYearsFromGfs(nextPolicy);

  const wasAutoClamped = current === previousMinimum;
  if (wasAutoClamped) {
    return nextMinimum;
  }

  return Math.max(current, nextMinimum);
}