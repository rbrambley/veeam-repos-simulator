export function normalizeForecastYears(value: number | null | undefined, fallback: number = 1): number {
  const resolvedFallback = Math.max(1, Math.floor(Number.isFinite(fallback) ? fallback : 1));
  const numericValue = Number.isFinite(value as number) ? Number(value) : resolvedFallback;
  return Math.max(1, Math.floor(numericValue));
}