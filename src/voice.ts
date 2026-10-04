/**
 * Turns a speech-recognition transcript into an intent. Rule-based on purpose:
 * it runs offline, is predictable for screen-reader users, and unknown
 * phrases come back as `unknown` instead of guessing.
 * Supports English and Polish.
 */
export type VoiceIntent =
  | { kind: 'list.add'; items: string[] }
  | { kind: 'list.done'; item: string }
  | { kind: 'list.remove'; item: string }
  | { kind: 'list.read' }
  | { kind: 'balance.mine' }
  | { kind: 'settle.read' }
  | { kind: 'bill.total' }
  | { kind: 'unknown'; text: string };

type Rule = [RegExp, (m: RegExpExecArray) => VoiceIntent];

const LIST = String.raw`(?:(?:to|on(?:to)?)\s+(?:the\s+|my\s+|our\s+)?(?:shopping\s+|packing\s+)?list|do\s+listy)`;

const RULES: Rule[] = [
  [new RegExp(String.raw`^(?:please\s+)?(?:add|put)\s+(.+?)(?:\s+${LIST})?$`, 'i'), (m) => ({ kind: 'list.add', items: splitItems(m[1]!) })],
  [new RegExp(String.raw`^(?:dodaj|wpisz)\s+(.+?)(?:\s+${LIST})?$`, 'i'), (m) => ({ kind: 'list.add', items: splitItems(m[1]!) })],
  [/^(?:tick off|check off|cross off|mark)\s+(.+?)(?:\s+as done)?$/i, (m) => ({ kind: 'list.done', item: m[1]!.trim() })],
  [/^(?:odhacz|zaznacz|skreśl)\s+(.+)$/i, (m) => ({ kind: 'list.done', item: m[1]!.trim() })],
  [/^(?:remove|delete)\s+(.+?)(?:\s+from\s+(?:the\s+)?list)?$/i, (m) => ({ kind: 'list.remove', item: m[1]!.trim() })],
  [/^(?:usuń|usun|wykreśl)\s+(.+?)(?:\s+z\s+listy)?$/i, (m) => ({ kind: 'list.remove', item: m[1]!.trim() })],
  [/^(?:read|what'?s on|show)\s+(?:the\s+)?list$|^(?:przeczytaj|co jest na)\s+list[eęy]$/i, () => ({ kind: 'list.read' })],
  [/how much do i owe|what do i owe|my balance|ile (?:jestem )?(?:winien|winna|winny)|m[oó]j bilans/i, () => ({ kind: 'balance.mine' })],
  [/who owes (?:whom|who)|settle ?up|kto (?:komu|ile) (?:jest )?(?:winien|oddaje)|rozlicz/i, () => ({ kind: 'settle.read' })],
  [/(?:read|what'?s) (?:the )?total|ile (?:wynosi )?(?:razem|rachunek)|podaj sum[eę]/i, () => ({ kind: 'bill.total' })],
];

export function parseVoiceCommand(transcript: string): VoiceIntent {
  const text = transcript.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  if (!text) return { kind: 'unknown', text: transcript };
  for (const [re, build] of RULES) {
    const m = re.exec(text);
    if (m) {
      const intent = build(m);
      if (intent.kind === 'list.add' && intent.items.length === 0) break;
      return intent;
    }
  }
  return { kind: 'unknown', text };
}

function splitItems(phrase: string): string[] {
  return phrase
    .split(/\s*(?:,|\band\b|\bi\b|\boraz\b)\s*/i)
    .map((s) => s.replace(/^(?:some|a|an|the)\s+/i, '').trim())
    .filter((s) => s.length > 0 && s.length <= 100);
}
