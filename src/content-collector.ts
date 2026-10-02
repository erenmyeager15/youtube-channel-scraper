import {
    extractContentPage,
    MAX_CONTENT_PAGE_ITEMS,
    type ContentItem,
    type ContentSection,
} from './content-pagination.js';

export type ContentCoverageStatus =
    | 'empty' | 'exhausted' | 'row-limit' | 'page-limit' | 'failed' | 'unsupported'
    | 'ambiguous-continuation' | 'repeated-continuation' | 'no-progress'
    | 'request-limit' | 'time-limit';

export interface ContentCoverage {
    section: ContentSection;
    status: ContentCoverageStatus;
    complete: boolean;
    /** Successfully received pages, including the supplied initial page. */
    pagesFetched: number;
    /** Unique mapped rows inspected, including rows excluded by a requested date window. */
    rowsSeen: number;
    duplicateRows: number;
    filteredRows: number;
    /** Unique rows with uncertain eligibility, including any beyond a row limit. */
    uncertainRows: number;
    rowsSelected: number;
    /** Whether the final verified page advertises another page; null means unverified. */
    morePagesAvailable: boolean | null;
    selectedTabVerified: boolean;
    /** Fixed categories only: never source errors, continuation tokens, or response bodies. */
    errorCategory?: string;
}

export interface CollectContentSectionOptions<T> {
    section: ContentSection;
    initialData: ContentItem;
    expectedChannelId?: string | null;
    maxPages: number;
    maxRows: number;
    fetchContinuation: (token: string) => Promise<ContentItem>;
    mapItems: (items: ContentItem[]) => T[];
    key: (row: T) => string;
    accept?: (row: T) => 'include' | 'exclude' | 'uncertain';
}

export interface CollectedContentSection<T> {
    rows: T[];
    coverage: ContentCoverage;
}

/**
 * Bounded collection of one verified channel feed. This does not assume chronological order:
 * even a fully date-excluded page can precede relevant pinned or reordered content.
 */
export async function collectContentSection<T>(
    options: CollectContentSectionOptions<T>,
): Promise<CollectedContentSection<T>> {
    validateLimit(options.maxPages, 5, 'maxPages');
    validateLimit(options.maxRows, 100, 'maxRows');

    const rows: T[] = [];
    const seenRows = new Set<string>();
    const requestedTokens = new Set<string>();
    const coverage: ContentCoverage = {
        section: options.section,
        status: 'unsupported',
        complete: false,
        pagesFetched: 0,
        rowsSeen: 0,
        duplicateRows: 0,
        filteredRows: 0,
        uncertainRows: 0,
        rowsSelected: 0,
        morePagesAvailable: null,
        selectedTabVerified: false,
    };
    const finish = (status: ContentCoverageStatus, errorCategory?: string): CollectedContentSection<T> => {
        coverage.status = status;
        coverage.rowsSelected = rows.length;
        coverage.complete = coverage.selectedTabVerified
            && (status === 'empty' || status === 'exhausted')
            && coverage.uncertainRows === 0;
        if (errorCategory) coverage.errorCategory = errorCategory;
        return { rows, coverage };
    };

    let data = options.initialData;
    let continuation = false;
    let continuationTargetId: string | null = null;
    while (coverage.pagesFetched < options.maxPages) {
        coverage.pagesFetched += 1;
        let page;
        try {
            page = extractContentPage(data, options.section, continuation, options.expectedChannelId, continuationTargetId);
        } catch {
            return finish('failed', 'page-parsing');
        }
        if (!continuation) coverage.selectedTabVerified = page.recognized;
        coverage.morePagesAvailable = page.recognized && !page.continuationAmbiguous
            ? page.continuationToken !== null : null;

        const seenBeforePage = coverage.rowsSeen;
        let rowOverflow = false;
        let mapped: T[];
        try {
            mapped = options.mapItems(page.items);
            if (!Array.isArray(mapped) || mapped.length > MAX_CONTENT_PAGE_ITEMS) {
                return finish('failed', 'item-mapping');
            }
            for (const row of mapped) {
                const rowKey = options.key(row);
                if (typeof rowKey !== 'string' || rowKey.length === 0) {
                    return finish('failed', 'item-mapping');
                }
                if (seenRows.has(rowKey)) {
                    coverage.duplicateRows += 1;
                    continue;
                }
                seenRows.add(rowKey);
                coverage.rowsSeen += 1;
                const decision = options.accept?.(row) ?? 'include';
                if (!['include', 'exclude', 'uncertain'].includes(decision)) {
                    return finish('failed', 'item-mapping');
                }
                if (decision === 'exclude') {
                    coverage.filteredRows += 1;
                    continue;
                }
                if (decision === 'uncertain') coverage.uncertainRows += 1;
                if (rows.length < options.maxRows) rows.push(row);
                else rowOverflow = true;
            }
        } catch {
            return finish('failed', 'item-mapping');
        }

        // Preserve safe partial rows, but do not follow tokens from an unverified structure.
        if (page.continuationAmbiguous) return finish('ambiguous-continuation', 'continuation-shape');
        if (!page.recognized) return finish('unsupported', 'page-shape');
        if (page.items.length > 0 && mapped.length === 0) return finish('unsupported', 'item-mapping');
        if (rowOverflow) return finish('row-limit');
        if (!page.continuationToken) {
            return finish(coverage.rowsSeen === 0 && page.emptyConfirmed ? 'empty' : 'exhausted');
        }
        if (rows.length >= options.maxRows) return finish('row-limit');
        if (requestedTokens.has(page.continuationToken)) return finish('repeated-continuation');
        if (continuation && coverage.rowsSeen === seenBeforePage) return finish('no-progress');
        if (coverage.pagesFetched >= options.maxPages) return finish('page-limit');

        requestedTokens.add(page.continuationToken);
        continuationTargetId = page.continuationTargetId;
        try {
            data = await options.fetchContinuation(page.continuationToken);
        } catch (error) {
            const reason = typeof error === 'object' && error !== null && 'reason' in error
                ? (error as { reason?: unknown }).reason : null;
            if (reason === 'request-limit' || reason === 'time-limit') return finish(reason, reason);
            return finish('failed', 'continuation-fetch');
        }
        continuation = true;
    }
    return finish('page-limit');
}

function validateLimit(value: number, maximum: number, name: string): void {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
    }
}
