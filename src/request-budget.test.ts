import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetLimitError, readBoundedBody, RequestBudget, ResponseSizeError } from './request-budget.js';

function assertBudgetReason(action: () => unknown, reason: 'request-limit' | 'time-limit'): void {
    assert.throws(action, (error: unknown) => error instanceof BudgetLimitError && error.reason === reason);
}

async function* chunks(...values: Array<Uint8Array | string>): AsyncGenerator<Uint8Array | string> {
    yield* values;
}

test('each admitted attempt consumes one slot and checks do not consume slots', () => {
    let now = 100;
    const budget = new RequestBudget(3, 240_000, () => now);
    assert.equal(budget.used, 0);
    budget.check();
    budget.checkTime();
    assert.equal(budget.used, 0);
    assert.equal(budget.take(), 30_000);
    assert.equal(budget.used, 1);
    now += 200_000;
    assert.equal(budget.take(), 30_000);
    now += 30_000;
    assert.equal(budget.take(), 10_000);
    assert.equal(budget.used, 3);
    assertBudgetReason(() => budget.take(), 'request-limit');
    assertBudgetReason(() => budget.check(), 'request-limit');
    assert.equal(budget.used, 3);
    // The final admitted attempt must still be allowed to consume its response.
    budget.checkTime();
});

test('the exact deadline blocks requests before incrementing and takes precedence over quota', () => {
    let now = 0;
    const budget = new RequestBudget(1, 100, () => now);
    now = 99;
    assert.equal(budget.take(), 1);
    budget.checkTime();
    now = 100;
    assertBudgetReason(() => budget.checkTime(), 'time-limit');
    assertBudgetReason(() => budget.check(), 'time-limit');
    assertBudgetReason(() => budget.take(), 'time-limit');
    assert.equal(budget.used, 1);

    const expiredBeforeFirstAttempt = new RequestBudget(2, 50, () => now);
    now = 150;
    assertBudgetReason(() => expiredBeforeFirstAttempt.take(), 'time-limit');
    assert.equal(expiredBeforeFirstAttempt.used, 0);
});

test('attempt and duration bounds reject invalid configuration', () => {
    for (const invalid of [0, -1, 1.1, 51, NaN, Infinity]) {
        assert.throws(() => new RequestBudget(invalid), RangeError);
    }
    for (const invalid of [0, -1, NaN, Infinity]) {
        assert.throws(() => new RequestBudget(1, invalid), RangeError);
    }
    assert.throws(() => new RequestBudget(1, 100, () => NaN), RangeError);
    assert.equal(new RequestBudget(50, 100, () => 0).take(), 100);
});

test('a non-finite clock cannot silently bypass the deadline', () => {
    let now = 0;
    const budget = new RequestBudget(2, 100, () => now);
    now = NaN;
    assertBudgetReason(() => budget.take(), 'time-limit');
    assert.equal(budget.used, 0);
});

test('bounded body accepts exactly the byte cap and preserves split UTF-8 bytes', async () => {
    assert.equal(await readBoundedBody(chunks('abc', Buffer.from('def')), 6), 'abcdef');
    const encoded = Buffer.from('a🙂é', 'utf8');
    assert.equal(await readBoundedBody(chunks(encoded.subarray(0, 3), encoded.subarray(3)), encoded.length), 'a🙂é');
    assert.equal(await readBoundedBody(chunks('', new Uint8Array()), 0), '');
});

test('bounded body measures strings as UTF-8 bytes, not characters', async () => {
    assert.equal(await readBoundedBody(chunks('é', '🙂'), 6), 'é🙂');
    await assert.rejects(readBoundedBody(chunks('é', '🙂'), 5),
        (error: unknown) => error instanceof ResponseSizeError && error.reason === 'response-size');
    await assert.rejects(readBoundedBody(chunks(Buffer.alloc(9)), 8), ResponseSizeError);
});

test('oversized body closes the iterator and does not consume following chunks', async () => {
    let consumed = 0;
    let closed = false;
    async function* source(): AsyncGenerator<string> {
        try {
            consumed += 1;
            yield 'abc';
            consumed += 1;
            yield 'def';
            consumed += 1;
            yield 'never read';
        } finally {
            closed = true;
        }
    }
    await assert.rejects(readBoundedBody(source(), 5), ResponseSizeError);
    assert.equal(consumed, 2);
    assert.equal(closed, true);
});

test('bounded body validates byte caps and propagates source failures', async () => {
    for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(readBoundedBody(chunks(''), invalid), RangeError);
    }
    const sourceFailure = new Error('Source failed.');
    async function* source(): AsyncGenerator<string> {
        yield 'abc';
        throw sourceFailure;
    }
    await assert.rejects(readBoundedBody(source(), 5), (error: unknown) => error === sourceFailure);
});
