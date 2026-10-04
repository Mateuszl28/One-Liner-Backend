/**
 * Hybrid logical clock. Gives every operation a timestamp that is close to
 * wall-clock time but still totally ordered and causally consistent, even
 * when phones have skewed clocks or were offline for hours.
 */
export interface Hlc {
  wall: number;
  counter: number;
  node: string;
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

export class HlcClock {
  private last: Hlc;

  constructor(
    readonly node: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.last = { wall: 0, counter: 0, node };
  }

  /** Timestamp for a new local event. */
  tick(): Hlc {
    const wall = Math.max(this.now(), this.last.wall);
    const counter = wall === this.last.wall ? this.last.counter + 1 : 0;
    this.last = { wall, counter, node: this.node };
    return this.last;
  }

  /** Records a timestamp seen from another device so later local events sort after it. */
  observe(remote: Hlc): void {
    if (remote.wall > this.last.wall || (remote.wall === this.last.wall && remote.counter > this.last.counter)) {
      this.last = { wall: remote.wall, counter: remote.counter, node: this.node };
    }
  }
}
