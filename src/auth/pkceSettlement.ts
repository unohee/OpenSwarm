export class PkceSettlement {
  private state: 'pending' | 'claimed' | 'settled' = 'pending';

  /** Atomically reserve the one callback allowed to perform an exchange. */
  tryClaim(): boolean {
    if (this.state !== 'pending') return false;
    this.state = 'claimed';
    return true;
  }

  /** Return true only for the first terminal completion. */
  finish(): boolean {
    if (this.state === 'settled') return false;
    this.state = 'settled';
    return true;
  }

  get settled(): boolean {
    return this.state === 'settled';
  }
}

export const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
