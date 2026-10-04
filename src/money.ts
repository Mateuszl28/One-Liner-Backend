/**
 * Money is always stored as integer minor units (cents, grosze) to avoid
 * floating point drift. Every split uses `allocate`, which guarantees the
 * parts add up to exactly the original amount.
 */
export type Cents = number;

export function assertCents(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer number of cents, got ${value}`);
  }
}

/** Parses "12.50", "12,50", "1 234,50", "-3.00" or a number of major units into cents. */
export function toCents(input: string | number): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`Invalid amount: ${input}`);
    return Math.round(input * 100);
  }
  const cleaned = input.replace(/[\s ']/g, '').replace(/[^\d.,-]/g, '');
  const match = /^(-?)(\d*)(?:[.,](\d{1,2}))?$/.exec(cleaned.replace(/[.,](?=\d{3}(?:[.,]|$))/g, ''));
  if (!match || (match[2] === '' && match[3] === undefined)) {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const [, sign, whole, frac = ''] = match;
  const cents = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0'));
  return sign === '-' ? -cents : cents;
}

export function formatMoney(cents: Cents, currency: string, locale = 'en'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Splits `total` into parts proportional to `weights` using the largest
 * remainder method. The result always sums to `total`. Ties are broken by key
 * so every device computes the same split. Zero total weight means equal split.
 */
export function allocate(total: Cents, weights: ReadonlyArray<readonly [string, number]>): Map<string, Cents> {
  assertCents(total, 'total');
  if (weights.length === 0) throw new Error('allocate needs at least one recipient');
  for (const [key, w] of weights) {
    if (!(w >= 0) || !Number.isFinite(w)) throw new Error(`Invalid weight ${w} for ${key}`);
  }

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const weightSum = weights.reduce((s, [, w]) => s + w, 0);
  const effective = weightSum > 0 ? weights : weights.map(([k]) => [k, 1] as const);
  const effectiveSum = weightSum > 0 ? weightSum : weights.length;

  const parts = effective.map(([key, w]) => {
    const exact = (abs * w) / effectiveSum;
    const floor = Math.floor(exact + 1e-9);
    return { key, floor, remainder: exact - floor };
  });

  let left = abs - parts.reduce((s, p) => s + p.floor, 0);
  const order = [...parts].sort((a, b) => b.remainder - a.remainder || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const part of order) {
    if (left <= 0) break;
    part.floor += 1;
    left -= 1;
  }

  const result = new Map<string, Cents>();
  for (const p of parts) result.set(p.key, (result.get(p.key) ?? 0) + sign * p.floor);
  return result;
}
