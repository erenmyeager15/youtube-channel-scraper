export type BudgetLimitReason = 'request-limit' | 'time-limit';

export class BudgetLimitError extends Error {
    readonly reason: BudgetLimitReason;

    constructor(reason: BudgetLimitReason) {
        super(reason === 'request-limit'
            ? 'The channel request-attempt limit was reached.'
            : 'The channel time limit was reached.');
        this.name = 'BudgetLimitError';
        this.reason = reason;
    }
}

/** A shared budget: each transport attempt, including retries, consumes one slot. */
export class RequestBudget {
    private attemptCount = 0;
    private readonly deadline: number;

    constructor(
        readonly maximumAttempts: number,
        durationMs = 240_000,
        private readonly now: () => number = Date.now,
    ) {
        if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 50) {
            throw new RangeError('maximumAttempts must be an integer from 1 to 50.');
        }
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            throw new RangeError('durationMs must be a positive finite number.');
        }
        const startedAt = this.now();
        this.deadline = startedAt + durationMs;
        if (!Number.isFinite(startedAt) || !Number.isFinite(this.deadline)) {
            throw new RangeError('The request-budget clock must provide a finite time.');
        }
    }

    get used(): number {
        return this.attemptCount;
    }

    /** Check whether another attempt may begin without consuming its slot. */
    check(): void {
        this.remainingTime();
        this.checkQuota();
    }

    /** Allow an already admitted attempt to finish even when its slot was the last one. */
    checkTime(): void {
        this.remainingTime();
    }

    remainingTimeMs(): number {
        return this.remainingTime();
    }

    /** Admit one attempt and return its timeout, bounded by the remaining wall time. */
    take(): number {
        const remaining = this.remainingTime();
        this.checkQuota();
        this.attemptCount += 1;
        return Math.min(30_000, remaining);
    }

    private checkQuota(): void {
        if (this.attemptCount >= this.maximumAttempts) {
            throw new BudgetLimitError('request-limit');
        }
    }

    private remainingTime(): number {
        const currentTime = this.now();
        if (!Number.isFinite(currentTime) || currentTime >= this.deadline) {
            throw new BudgetLimitError('time-limit');
        }
        return this.deadline - currentTime;
    }
}

export class ResponseSizeError extends Error {
    readonly reason = 'response-size' as const;

    constructor() {
        super('The decoded response exceeded its byte limit.');
        this.name = 'ResponseSizeError';
    }
}

/** Read decoded transport chunks without retaining or concatenating an oversized body. */
export async function readBoundedBody(
    source: AsyncIterable<Uint8Array | string>,
    maximumBytes = 8 * 1024 * 1024,
): Promise<string> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
        throw new RangeError('maximumBytes must be a non-negative safe integer.');
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of source) {
        const byteLength = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
        if (byteLength > maximumBytes - totalBytes) {
            // Throwing inside for-await also invokes the source iterator's return method.
            throw new ResponseSizeError();
        }
        if (byteLength !== 0) chunks.push(Buffer.from(chunk));
        totalBytes += byteLength;
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
}
