/**
 * QR invite. The QR only tells the joining phone which Gather and which host
 * device to pair with; trust is still established by GatherNet pairing
 * (system confirmation on both phones), never by the QR alone.
 */
export interface Invite {
  gatherId: string;
  gatherName: string;
  /** Host device id as seen by the distributed device manager. */
  hostDeviceId: string;
  /** Short code both screens show so people can check they paired the right phone. */
  code: string;
  /** Unix ms after which the invite is refused. */
  expiresAt: number;
}

const SCHEME = 'gather://join';
export const INVITE_TTL_MS = 15 * 60 * 1000;

export function makeInviteCode(random: () => number = Math.random): string {
  return String(Math.floor(random() * 1_000_000)).padStart(6, '0');
}

export function encodeInvite(invite: Invite): string {
  const params: Array<[string, string]> = [
    ['g', invite.gatherId],
    ['n', invite.gatherName],
    ['h', invite.hostDeviceId],
    ['c', invite.code],
    ['e', String(invite.expiresAt)],
  ];
  return `${SCHEME}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// React Native's URLSearchParams is incomplete, so parse by hand.
function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    try {
      params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')));
    } catch {
      // Malformed escape sequence: leave the key out, validation below rejects the invite.
    }
  }
  return params;
}

export type InviteResult = { ok: true; invite: Invite } | { ok: false; error: 'not-a-gather-code' | 'malformed' | 'expired' };

export function decodeInvite(text: string, now = Date.now()): InviteResult {
  if (!text.startsWith(`${SCHEME}?`)) return { ok: false, error: 'not-a-gather-code' };
  const params = parseQuery(text.slice(SCHEME.length + 1));
  const gatherId = params.get('g') ?? '';
  const hostDeviceId = params.get('h') ?? '';
  const code = params.get('c') ?? '';
  const expiresAt = Number(params.get('e'));
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(gatherId) || !hostDeviceId || hostDeviceId.length > 256 || !/^\d{6}$/.test(code) || !Number.isFinite(expiresAt)) {
    return { ok: false, error: 'malformed' };
  }
  if (expiresAt < now) return { ok: false, error: 'expired' };
  return { ok: true, invite: { gatherId, gatherName: (params.get('n') ?? '').slice(0, 100), hostDeviceId, code, expiresAt } };
}
