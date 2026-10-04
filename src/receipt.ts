import type { Cents } from './money.js';
import type { ReceiptItemInput } from './ops.js';

/** One text line as returned by the ReceiptAI native module (on-device OCR). */
export interface OcrLine {
  text: string;
  /** 0..1 OCR confidence for the line. */
  confidence: number;
}

export interface ParsedReceipt {
  merchant: string | null;
  currency: string | null;
  items: ReceiptItemInput[];
  subtotalCents: Cents | null;
  taxCents: Cents;
  /** Prices already include tax (typical for EU receipts, e.g. Polish "PTU"). */
  taxIncluded: boolean;
  tipCents: Cents;
  serviceCents: Cents;
  totalCents: Cents | null;
  /** Human-readable notes about what could not be read; never silently dropped. */
  warnings: string[];
}

const PRICE_AT_END = /(-?\d{1,3}(?:[ .,']\d{3})*[.,]\d{2}|-?\d+[.,]\d{2})\s*(?:[A-Z]{1,3}|€|\$|£|zł|zl|PLN|EUR|USD)?\s*[*#]?\s*$/i;
const QTY_PREFIX = /^\s*(\d{1,3})\s*[x×*]\s+/i;
const QTY_TIMES_PRICE = /(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+[.,]\d{2})/i;

const KEYWORDS: Array<[RegExp, 'total' | 'subtotal' | 'tax' | 'tip' | 'service' | 'skip']> = [
  [/\b(sub\s*-?total|zwischensumme|suma\s+częściowa|netto)\b/i, 'subtotal'],
  [/\b(total|suma|razem|do\s+zap[łl]aty|summe|gesamt|amount\s+due|balance\s+due|à\s+payer|totale)\b/i, 'total'],
  [/\b(tip|gratuity|napiwek|trinkgeld|pourboire|mancia)\b/i, 'tip'],
  [/\b(service|serwis|bedienung|coperto)\b/i, 'service'],
  [/\b(tax|vat|ptu|mwst|ust|tva|iva)\b/i, 'tax'],
  [
    /\b(cash|card|karta|got[óo]wka|change|reszta|visa|mastercard|nip|tel|paragon|fiskalny|rechnung|receipt|invoice|faktura|thank|dzi[eę]kujemy|danke|merci|table|stolik|kelner|waiter|date|data|godz|time)\b/i,
    'skip',
  ],
];

const CURRENCY_HINTS: Array<[RegExp, string]> = [
  [/zł|\bPLN\b|\bzl\b/i, 'PLN'],
  [/€|\bEUR\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/\$|\bUSD\b/i, 'USD'],
  [/\bCHF\b/i, 'CHF'],
  [/\bCZK\b|Kč/i, 'CZK'],
];

/** Parses an amount found on a receipt line, tolerating "1 234,50" and "1.234,50". */
export function parseReceiptAmount(raw: string): Cents {
  const negative = raw.trim().startsWith('-');
  const digits = raw.replace(/[^\d.,]/g, '');
  const sepIndex = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
  const whole = digits.slice(0, sepIndex).replace(/[.,]/g, '');
  const frac = digits.slice(sepIndex + 1);
  const cents = Number(whole || '0') * 100 + Number(frac);
  return negative ? -cents : cents;
}

let fallbackIdCounter = 0;

/**
 * Turns OCR lines into items, tax, tip and total.
 *
 * This is the deterministic post-processing that runs after the on-device
 * OCR / MindSpore Lite model. Its job is to be honest about uncertainty: each
 * item carries a confidence, and anything that does not add up produces a
 * warning that the UI shows before anyone pays.
 */
export function parseReceipt(lines: OcrLine[], makeId: () => string = () => `item-${++fallbackIdCounter}`): ParsedReceipt {
  const result: ParsedReceipt = {
    merchant: null,
    currency: null,
    items: [],
    subtotalCents: null,
    taxCents: 0,
    taxIncluded: false,
    tipCents: 0,
    serviceCents: 0,
    totalCents: null,
    warnings: [],
  };

  const allText = lines.map((l) => l.text).join('\n');
  result.currency = CURRENCY_HINTS.find(([re]) => re.test(allText))?.[1] ?? null;

  let seenFirstPrice = false;
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const ocrConfidence = clamp01(line.confidence);
    const priceMatch = PRICE_AT_END.exec(text);

    if (!priceMatch) {
      if (!seenFirstPrice && !result.merchant && /[a-z]{3,}/i.test(text) && !/\d{5,}/.test(text)) {
        result.merchant = text;
      }
      continue;
    }
    seenFirstPrice = true;
    const amount = parseReceiptAmount(priceMatch[1]!);
    const label = text.slice(0, priceMatch.index).trim();
    const kind = KEYWORDS.find(([re]) => re.test(label))?.[1];

    switch (kind) {
      case 'total':
        // The last "total" wins: receipts often print SUMA then SUMA PLN again.
        result.totalCents = amount;
        continue;
      case 'subtotal':
        result.subtotalCents = amount;
        continue;
      case 'tax':
        result.taxCents += amount;
        continue;
      case 'tip':
        result.tipCents += amount;
        continue;
      case 'service':
        result.serviceCents += amount;
        continue;
      case 'skip':
        continue;
    }

    if (result.totalCents !== null) continue; // lines after the total are payment details

    let name = label;
    let quantity = 1;
    let confidence = ocrConfidence;
    const qtyPrefix = QTY_PREFIX.exec(name);
    if (qtyPrefix) {
      quantity = Number(qtyPrefix[1]);
      name = name.slice(qtyPrefix[0].length);
    }
    const qtyTimes = QTY_TIMES_PRICE.exec(name);
    if (qtyTimes) {
      quantity = Number(qtyTimes[1]!.replace(',', '.'));
      const unit = parseReceiptAmount(qtyTimes[2]!);
      name = name.slice(0, qtyTimes.index).trim();
      // A unit price times quantity that disagrees with the line total means a digit was misread.
      if (Math.abs(Math.round(unit * quantity) - amount) > 1) confidence = Math.min(confidence, 0.5);
    }
    name = name.replace(/\s+[A-D]$/, '').replace(/[.\s]+$/, '').trim(); // drop Polish VAT class letter
    if (!/[a-zà-žąćęłńóśźż]{2,}/i.test(name)) {
      confidence = Math.min(confidence, 0.4);
      name = name || 'Unknown item';
    }
    if (amount < 0 && !/rabat|discount|rabatt|remise|promo/i.test(name)) confidence = Math.min(confidence, 0.6);

    result.items.push({ id: makeId(), name, priceCents: amount, quantity, shared: false, confidence });
  }

  reconcile(result);
  return result;
}

function reconcile(r: ParsedReceipt): void {
  const itemsSum = r.items.reduce((s, i) => s + i.priceCents, 0);
  if (r.items.length === 0) r.warnings.push('No items were recognised. Add them manually.');

  if (r.totalCents === null) {
    r.warnings.push('No total found on the receipt. Check the amount before splitting.');
    return;
  }

  const extras = r.tipCents + r.serviceCents;
  if (itemsSum + extras === r.totalCents) {
    // Tax line is informational: prices already include it.
    r.taxIncluded = r.taxCents > 0;
    return;
  }
  if (itemsSum + r.taxCents + extras === r.totalCents) return;

  const diff = r.totalCents - (itemsSum + (r.taxIncluded ? 0 : r.taxCents) + extras);
  r.warnings.push(
    `Items add up to ${(itemsSum / 100).toFixed(2)} but the receipt total is ${(r.totalCents / 100).toFixed(2)} ` +
      `(difference ${(diff / 100).toFixed(2)}). Check highlighted prices.`,
  );
  // Without a matching sum, any item could be the misread one; mark them for review.
  for (const item of r.items) item.confidence = Math.min(item.confidence, 0.79);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
