import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicYouTubeUrl, fetchBoundedHttp, transportLimitReason } from './bounded-http.js';
import type { HttpStream, StreamFactory } from './bounded-http.js';
import { BudgetLimitError, RequestBudget, ResponseSizeError } from './request-budget.js';

type Response = { statusCode: number; url: string };
type Request = Record<string, any>;
const sourceUrl = 'https://www.youtube.com/@example/videos';
const headers = { 'accept-language': 'en-US' };

class FakeStream implements HttpStream {
    destroyCalls = 0;
    iteratorClosed = 0;
    chunksRead = 0;
    private listener?: (response: Response) => void;

    constructor(
        private readonly chunks: Array<Uint8Array | string> = ['public response'],
        private readonly response?: Response,
        private readonly beforeReading?: () => void | Promise<void>,
    ) {}

    on(_event: 'response', listener: (response: Response) => void): this {
        this.listener = listener;
        return this;
    }

    destroy(): this {
        this.destroyCalls += 1;
        return this;
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array | string> {
        try {
            await this.beforeReading?.();
            if (this.response) this.listener?.(this.response);
            for (const chunk of this.chunks) {
                this.chunksRead += 1;
                yield chunk;
            }
        } finally {
            this.iteratorClosed += 1;
        }
    }
}

function admit(options: Request, url = options.url): Request {
    const request = { ...options, url: new URL(url), timeout: { ...options.timeout } };
    options.hooks.beforeRequest[0](request);
    return request;
}

function assertSanitized(error: unknown, reason?: string): boolean {
    assert.ok(error instanceof Error);
    assert.equal(error.message, reason ? `YouTube transport stopped: ${reason}.` : 'YouTube HTTP transport failed.');
    assert.equal((error as Error & { reason?: string }).reason, reason);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('private-token'));
    assert.ok(!error.message.includes('proxy-password'));
    return true;
}

test('compact metadata response caps and zero redirects reach the transport without changing normal defaults', async () => {
    let captured: Request | undefined;
    const stream = new FakeStream(['12345'], { statusCode: 200, url: sourceUrl });
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers, maximumResponseBytes: 4, maximumRedirects: 0 },
        new RequestBudget(2), options => { captured = options; admit(options); return stream; }),
    error => assertSanitized(error, 'response-size'));
    assert.equal(captured!.maxRedirects, 0);
    assert.equal(captured!.maximumResponseBytes, undefined);
    assert.equal(stream.destroyCalls, 1);
    assert.equal(stream.iteratorClosed, 1);
});

test('invalid compact response and redirect bounds fail before starting network activity', async () => {
    for (const limits of [{ maximumResponseBytes: 0 }, { maximumResponseBytes: 8 * 1024 * 1024 + 1 },
        { maximumResponseBytes: 1.5 }, { maximumRedirects: -1 }, { maximumRedirects: 4 }]) {
        let calls = 0;
        await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers, ...limits }, new RequestBudget(1), () => {
            calls += 1; return new FakeStream();
        }), /Invalid bounded HTTP limits/);
        assert.equal(calls, 0);
    }
});

test('every beforeRequest attempt, including redirect attempts, consumes a budget slot', async () => {
    const budget = new RequestBudget(3, 240_000, () => 0);
    let captured: Request | undefined;
    let stream: FakeStream | undefined;
    const factory: StreamFactory = (options) => {
        captured = options;
        stream = new FakeStream(['body'], { statusCode: 200, url: 'https://www.youtube.com/@example/videos' }, () => {
            admit(options);
            for (const url of ['https://youtube.com/@example/videos', sourceUrl]) {
                const redirected = { ...options, url: new URL(url), timeout: { ...options.timeout } };
                options.hooks.beforeRedirect[0](redirected);
                options.hooks.beforeRequest[0](redirected);
            }
        });
        return stream;
    };
    const result = await fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory);
    assert.deepEqual(result, { statusCode: 200, url: sourceUrl, body: 'body' });
    assert.equal(budget.used, 3);
    assert.equal(captured?.retry.limit, 0);
    assert.equal(captured?.throwHttpErrors, false);
    assert.equal(captured?.followRedirect, true);
    assert.equal(captured?.maxRedirects, 3);
    assert.equal(captured?.decompress, true);
    assert.equal(stream?.destroyCalls, 1);
});

test('request timeout clips to the remaining deadline on the initial request and redirects', async () => {
    let now = 0;
    const budget = new RequestBudget(2, 45_000, () => now);
    const timeouts: number[] = [];
    const factory: StreamFactory = (options) => new FakeStream(['body'], { statusCode: 200, url: sourceUrl }, () => {
        timeouts.push(admit(options).timeout.request);
        now = 25_000;
        const redirected = { ...options, url: new URL(sourceUrl), timeout: { ...options.timeout } };
        options.hooks.beforeRedirect[0](redirected);
        assert.equal(budget.used, 1, 'checking a redirect destination does not consume an attempt');
        options.hooks.beforeRequest[0](redirected);
        timeouts.push(redirected.timeout.request);
    });
    await fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory);
    assert.deepEqual(timeouts, [30_000, 20_000]);
    assert.equal(budget.used, 2);
});

test('the body of the last permitted request may finish', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    const factory: StreamFactory = (options) => new FakeStream(['one', 'two'], { statusCode: 200, url: sourceUrl }, () => {
        assert.equal(admit(options).timeout.request, 100);
    });
    assert.equal((await fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory)).body, 'onetwo');
    assert.equal(budget.used, 1);
});

test('unsafe initial destinations fail before a stream or HTTP attempt is opened', async () => {
    const unsafe = [
        'http://www.youtube.com/@example', 'https://youtube.com.evil.example/@example',
        'https://private.youtube.com/@example', 'https://localhost/@example',
        'https://www.youtube.com:8443/@example', 'https://user:proxy-password@www.youtube.com/@example',
        'file:///youtube.com', 'not a URL',
    ];
    for (const url of unsafe) {
        const budget = new RequestBudget(1, 100, () => 0);
        let opened = false;
        await assert.rejects(fetchBoundedHttp({ url, headers }, budget, () => {
            opened = true;
            return new FakeStream();
        }));
        assert.equal(opened, false, url);
        assert.equal(budget.used, 0, url);
    }
    for (const url of ['https://www.youtube.com/@example', 'https://youtube.com/@example', 'https://m.youtube.com/@example']) {
        assert.doesNotThrow(() => assertPublicYouTubeUrl(url));
    }
});

test('unsafe redirect destinations fail before the redirected attempt and destroy the stream', async () => {
    for (const hook of ['beforeRedirect', 'beforeRequest']) {
        const budget = new RequestBudget(3, 100, () => 0);
        let stream: FakeStream | undefined;
        const factory: StreamFactory = (options) => {
            stream = new FakeStream(['never read'], { statusCode: 200, url: sourceUrl }, () => {
                admit(options);
                options.hooks[hook][0]({ ...options, url: new URL('https://evil.example/?private-token=secret') });
            });
            return stream;
        };
        await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory), (error) => assertSanitized(error));
        assert.equal(budget.used, 1, hook);
        assert.equal(stream?.destroyCalls, 1, hook);
    }
});

test('an unsafe final response URL is rejected even if a transport bypasses the redirect hook', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    const factory: StreamFactory = (options) => new FakeStream(['body'], { statusCode: 200, url: 'https://evil.example/' }, () => {
        admit(options);
    });
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory), (error) => assertSanitized(error));
});

test('HTTP status, final public URL, UTF-8 body and request options are preserved', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    let captured: Request | undefined;
    const finalUrl = 'https://m.youtube.com/@example/videos';
    const factory: StreamFactory = (options) => {
        captured = options;
        return new FakeStream(['é', Buffer.from('🙂')], { statusCode: 429, url: finalUrl }, () => { admit(options); });
    };
    const request = { url: sourceUrl, method: 'POST' as const, headers, body: '{"continuation":"private-token"}', proxyUrl: 'http://user:proxy-password@proxy.example' };
    assert.deepEqual(await fetchBoundedHttp(request, budget, factory), { statusCode: 429, url: finalUrl, body: 'é🙂' });
    assert.equal(captured?.method, 'POST');
    assert.equal(captured?.body, request.body);
    assert.equal(captured?.proxyUrl, request.proxyUrl);
    assert.deepEqual(captured?.headers, headers);
});

test('oversized decoded bodies stop at 8 MiB, close the iterator and destroy the stream', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    let stream: FakeStream | undefined;
    const factory: StreamFactory = (options) => {
        stream = new FakeStream([Buffer.alloc(8 * 1024 * 1024), 'é', 'never read'], { statusCode: 200, url: sourceUrl }, () => {
            admit(options);
        });
        return stream;
    };
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory), (error) => assertSanitized(error, 'response-size'));
    assert.equal(stream?.chunksRead, 2);
    assert.equal(stream?.iteratorClosed, 1);
    assert.equal(stream?.destroyCalls, 1);
    assert.equal(budget.used, 1);
});

test('raw asynchronous stream errors are sanitized without retaining their cause', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    let stream: FakeStream | undefined;
    const factory: StreamFactory = (options) => {
        stream = new FakeStream([], undefined, () => {
            admit(options);
            throw new Error('proxy-password private-token failed');
        });
        return stream;
    };
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory), (error) => assertSanitized(error));
    assert.equal(stream?.destroyCalls, 1);
});

test('raw synchronous stream-factory errors are sanitized', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, () => {
        throw new Error('proxy-password private-token failed');
    }), (error) => assertSanitized(error));
});

test('listener setup failures are sanitized and destroy an already created stream', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    const stream = new FakeStream();
    stream.on = () => { throw new Error('proxy-password private-token failed'); };
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, () => stream), (error) => assertSanitized(error));
    assert.equal(stream.destroyCalls, 1);
});

test('nested Got causes retain only recognized limit reasons', async () => {
    const causes = [new BudgetLimitError('request-limit'), new BudgetLimitError('time-limit'), new ResponseSizeError()];
    for (const cause of causes) {
        const error = new Error('private-token wrapped', { cause: new Error('proxy-password inner', { cause }) });
        assert.equal(transportLimitReason(error), cause.reason);
        const budget = new RequestBudget(1, 100, () => 0);
        const factory: StreamFactory = (options) => new FakeStream([], undefined, () => {
            admit(options);
            throw error;
        });
        await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory), (failure) => assertSanitized(failure, cause.reason));
    }
    assert.equal(transportLimitReason(new Error('ordinary failure')), null);
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    assert.equal(transportLimitReason(cycle), null);
});

test('a redirect exceeding the request quota is stopped without incrementing past the cap', async () => {
    const budget = new RequestBudget(2, 100, () => 0);
    let stream: FakeStream | undefined;
    const factory: StreamFactory = (options) => {
        stream = new FakeStream(['never read'], { statusCode: 200, url: sourceUrl }, () => {
            admit(options);
            admit(options);
            admit(options);
        });
        return stream;
    };
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory), (error) => assertSanitized(error, 'request-limit'));
    assert.equal(budget.used, 2);
    assert.equal(stream?.destroyCalls, 1);
});

test('deadline exhaustion during response reading stops and cleans up the admitted request', async () => {
    let now = 0;
    const budget = new RequestBudget(1, 100, () => now);
    let stream: FakeStream | undefined;
    const factory: StreamFactory = (options) => {
        stream = new FakeStream(['never retained'], { statusCode: 200, url: sourceUrl }, () => {
            admit(options);
            now = 100;
        });
        return stream;
    };
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory), (error) => assertSanitized(error, 'time-limit'));
    assert.equal(budget.used, 1);
    assert.equal(stream?.iteratorClosed, 1);
    assert.equal(stream?.destroyCalls, 1);
});

test('missing response headers fail closed and clean up the stream', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    let stream: FakeStream | undefined;
    const factory: StreamFactory = (options) => {
        stream = new FakeStream(['body'], undefined, () => { admit(options); });
        return stream;
    };
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory), (error) => assertSanitized(error));
    assert.equal(stream?.destroyCalls, 1);
});

test('an outer deadline rejects a stalled preflight before response headers exist', async () => {
    const budget = new RequestBudget(1, 15);
    let stream: FakeStream | undefined;
    let signal: AbortSignal | undefined;
    const factory: StreamFactory = (options) => {
        signal = options.signal;
        stream = new FakeStream([], undefined, () => new Promise<void>(() => {}));
        return stream;
    };
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, factory),
        (error) => assertSanitized(error, 'time-limit'));
    assert.equal(budget.used, 0, 'no source request was admitted during stalled preflight');
    assert.equal(signal?.aborted, true);
    assert.ok(stream!.destroyCalls >= 1);
});

test('cleanup failures cannot replace sanitized setup errors', async () => {
    const budget = new RequestBudget(1, 100, () => 0);
    const stream = new FakeStream();
    stream.on = () => { throw new Error('private-token setup failed'); };
    stream.destroy = () => { throw new Error('proxy-password cleanup failed'); };
    await assert.rejects(fetchBoundedHttp({ url: sourceUrl, headers }, budget, () => stream),
        (error) => assertSanitized(error));
});

test('bounded requests reuse a browser-header token per budget, never across unrelated budgets', async () => {
    const tokens: unknown[] = [];
    const factory: StreamFactory = options => {
        tokens.push(options.sessionToken);
        return new FakeStream(['body'], { statusCode: 200, url: sourceUrl }, () => { admit(options); });
    };
    const first = new RequestBudget(2);
    await fetchBoundedHttp({ url: sourceUrl, headers }, first, factory);
    await fetchBoundedHttp({ url: sourceUrl, headers }, first, factory);
    const second = new RequestBudget(1);
    await fetchBoundedHttp({ url: sourceUrl, headers }, second, factory);
    assert.equal(tokens[0], tokens[1]);
    assert.notEqual(tokens[0], tokens[2]);
    assert.deepEqual(tokens[0], {});
    assert.equal(first.used, 2);
    assert.equal(second.used, 1);
});
