export interface PublicationWindow {
    publishedAfter: string | null;
    publishedBefore: string | null;
}

export type PublicationPrecision = 'exact' | 'day' | 'relative' | 'unknown';

export interface PublicationObservation {
    /** Only an exact timestamp or the start of a known UTC day; relative ages are never exact. */
    publishedAt: string | null;
    publishedAtPrecision: PublicationPrecision;
    publishedAtEarliest: string | null;
    publishedAtLatest: string | null;
    sourceDateText: string | null;
}

export type PublicationWindowMatch = 'in-window' | 'outside-window' | 'uncertain' | 'not-requested';

interface ParsedIso {
    earliest: number;
    latest: number;
    precision: 'exact' | 'day';
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function validCalendarDate(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= monthLengths[month - 1];
}

/** Do not use Date.parse alone: it silently normalizes invalid dates such as February 30. */
function parseIso(value: string): ParsedIso | null {
    const date = ISO_DATE.exec(value);
    if (date) {
        if (!validCalendarDate(Number(date[1]), Number(date[2]), Number(date[3]))) return null;
        const earliest = Date.parse(`${value}T00:00:00.000Z`);
        if (!Number.isFinite(earliest)) return null;
        return { earliest, latest: earliest + DAY_MS - 1, precision: 'day' };
    }

    const timestamp = ISO_TIMESTAMP.exec(value);
    if (!timestamp) return null;
    const [, year, month, day, hour, minute, second, , timezone] = timestamp;
    if (!validCalendarDate(Number(year), Number(month), Number(day))) return null;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return null;
    if (timezone !== 'Z') {
        const [offsetHour, offsetMinute] = timezone.slice(1).split(':').map(Number);
        if (offsetHour > 23 || offsetMinute > 59) return null;
    }
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) return null;
    return { earliest: instant, latest: instant, precision: 'exact' };
}

function boundary(value: unknown, side: 'publishedAfter' | 'publishedBefore'): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new Error(`${side} must be an ISO date or timestamp.`);
    const text = value.trim();
    if (!text) return null;
    const parsed = parseIso(text);
    if (!parsed) {
        throw new Error(`${side} must be a valid ISO date (YYYY-MM-DD) or timestamp with a timezone.`);
    }
    return new Date(side === 'publishedAfter' ? parsed.earliest : parsed.latest).toISOString();
}

export function normalizeDateWindow(publishedAfter?: unknown, publishedBefore?: unknown): PublicationWindow {
    const window = {
        publishedAfter: boundary(publishedAfter, 'publishedAfter'),
        publishedBefore: boundary(publishedBefore, 'publishedBefore'),
    };
    if (window.publishedAfter && window.publishedBefore
        && Date.parse(window.publishedAfter) > Date.parse(window.publishedBefore)) {
        throw new Error('publishedAfter must be earlier than or equal to publishedBefore.');
    }
    return window;
}

function unknownObservation(sourceDateText: string | null): PublicationObservation {
    return {
        publishedAt: null,
        publishedAtPrecision: 'unknown',
        publishedAtEarliest: null,
        publishedAtLatest: null,
        sourceDateText,
    };
}

function absoluteObservation(parsed: ParsedIso, sourceDateText: string | null): PublicationObservation {
    return {
        publishedAt: new Date(parsed.earliest).toISOString(),
        publishedAtPrecision: parsed.precision,
        publishedAtEarliest: new Date(parsed.earliest).toISOString(),
        publishedAtLatest: new Date(parsed.latest).toISOString(),
        sourceDateText,
    };
}

/**
 * Relative labels are rounded display ages, not publication timestamps. Leave publishedAt null
 * and allow a unit of uncertainty on either side. Month/year durations also vary by calendar.
 */
export function observePublicationDate(
    raw: string | null,
    observedAt: string,
    exactDate?: string | null,
): PublicationObservation {
    const sourceDateText = raw?.trim() || null;
    if (typeof exactDate === 'string') {
        const exact = parseIso(exactDate.trim());
        if (exact) return absoluteObservation(exact, sourceDateText);
    }
    if (!sourceDateText) return unknownObservation(null);
    const absolute = parseIso(sourceDateText);
    if (absolute) return absoluteObservation(absolute, sourceDateText);

    const relative = /^(?:(?:Streamed|Premiered)\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|h|d|w|mo|y)\s+ago$/i.exec(sourceDateText);
    const observationTime = parseIso(observedAt);
    if (!relative || !observationTime || observationTime.precision !== 'exact') {
        return unknownObservation(sourceDateText);
    }
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount)) return unknownObservation(sourceDateText);
    const unitDurations: Record<string, [number, number]> = {
        minute: [60_000, 60_000],
        hour: [3_600_000, 3_600_000],
        day: [DAY_MS, DAY_MS],
        week: [7 * DAY_MS, 7 * DAY_MS],
        month: [28 * DAY_MS, 31 * DAY_MS],
        year: [365 * DAY_MS, 366 * DAY_MS],
    };
    const label = relative[2].toLowerCase();
    const unit = /^(?:minute|min)/.test(label) ? 'minute'
        : /^(?:hour|hr|h$)/.test(label) ? 'hour'
            : /^(?:day|d$)/.test(label) ? 'day'
                : /^(?:week|w$)/.test(label) ? 'week'
                    : /^(?:month|mo$)/.test(label) ? 'month' : 'year';
    const [minimumUnit, maximumUnit] = unitDurations[unit];
    const earliest = observationTime.earliest - (amount + 1) * maximumUnit;
    const latest = observationTime.latest - Math.max(0, amount - 1) * minimumUnit;
    if (!Number.isFinite(new Date(earliest).getTime()) || !Number.isFinite(new Date(latest).getTime())) {
        return unknownObservation(sourceDateText);
    }
    return {
        publishedAt: null,
        publishedAtPrecision: 'relative',
        publishedAtEarliest: new Date(earliest).toISOString(),
        publishedAtLatest: new Date(latest).toISOString(),
        sourceDateText,
    };
}

export function evaluatePublicationWindow(
    observation: PublicationObservation,
    requestedWindow: PublicationWindow,
): PublicationWindowMatch {
    const window = normalizeDateWindow(requestedWindow.publishedAfter, requestedWindow.publishedBefore);
    if (!window.publishedAfter && !window.publishedBefore) return 'not-requested';
    if (observation.publishedAtPrecision === 'unknown'
        || !observation.publishedAtEarliest || !observation.publishedAtLatest) return 'uncertain';
    const earliest = parseIso(observation.publishedAtEarliest);
    const latest = parseIso(observation.publishedAtLatest);
    if (!earliest || !latest || earliest.earliest > latest.latest) return 'uncertain';
    const after = window.publishedAfter ? Date.parse(window.publishedAfter) : null;
    const before = window.publishedBefore ? Date.parse(window.publishedBefore) : null;
    if ((after !== null && latest.latest < after) || (before !== null && earliest.earliest > before)) {
        return 'outside-window';
    }
    if ((after === null || earliest.earliest >= after) && (before === null || latest.latest <= before)) {
        return 'in-window';
    }
    return 'uncertain';
}
