# YouTube creator comparison checklist for US agencies

Purpose: prepare a transparent creator or competitor research table from public
channel snapshots. This is a manual/external reporting workflow using existing
Actor fields, not a new scraper feature or a verified sponsorship recommendation.

[Open the research starter](https://apify.com/fascinating_lentil/youtube-channel-scraper/examples/us-youtube-creator-research)
or use [its saved input](us-youtube-creator-research.json). It is a configuration,
not a newly verified live dataset. MKBHD and iJustine are illustrative channels,
not endorsements; US-first refers to buyers, not a US audience guarantee.

## Before collection

- Select direct channel URLs for your shortlist. Do not infer suitability from
  subscriber count alone or use the example set as a ranked recommendation.
- Begin with Fast mode: two URLs, up to five videos and three Shorts each,
  one page per selected section and ten HTTP attempts per channel. No proxy,
  detailed enrichment, schedule, or automatic history in this starter.
- Two saved channels incur $0.00605 in listed events at the current FREE-tier
  price, including the minimum start event at 256 MB; $0.00515 at the lowest
  current discounted channel price. Fewer successful channels reduce channel
  event counts. These are listed fees, not measured source availability or margins.

## Prepare the exports

1. Retain the full CSV/JSON dataset, `RUN-SUMMARY`, input, run ID and collection
   date together. The summary is a separate key-value-store record, not a dataset
   row. Note page/request limits, failed or incomplete sections, date uncertainty,
   and remaining public pages.
2. Split rows by `recordType`: `channel`, `video`, `playlist`, `community_post`.
   A display view selects fields; it does not filter the dataset to one record
   type. The existing Videos view excludes `channelUrl`; select that field
   explicitly or use the full export rather than joining by `channelName`.
3. Join videos to channels using `channelUrl`. Keep `channelId` when supplied
   for matching subsequent channel snapshots. Deduplicate content by `videoId`.
   A renamed handle or missing identity requires manual reconciliation, not a
   speculative automatic match.
4. Group `contentType` separately: regular videos, Shorts and live streams.
   Keep raw count labels, parsed numeric counts and `scrapedAt` together.
5. Never replace null/missing counts with zero. Fast mode does not enrich
   likes, comments, public external links, About details or exact watch-page dates.

## Suggested client table

Include channel identity and public URL, observation timestamp, displayed
subscriber count, parsed subscriber count, requested sample limits, actual saved
video/Short rows, coverage status, a few relevant titles and their public URLs.
Describe the sample as bounded, not a complete archive or a ranked score.

Compare median public view counts only within a clearly labeled format and
sample. Different publishing dates, sample sizes, rounded values and source
failures prevent fair claims of overall performance. These views are lifetime
counts observed now, not views earned in the last week/month.

For publication timing retain `sourceDateText`, `publishedAtPrecision`,
`publishedAtEarliest`, `publishedAtLatest` and `publicationWindowMatch`. Keep
unknown or uncertain dates out of exact cadence calculations. A Detailed-mode
calendar day does not establish an exact posting timestamp.

If you opt into Detailed mode later, enrich a small selection of videos and
inspect which fields actually arrived. Websites/social profiles are public links,
not verified contacts; emails and phone numbers are excluded/redacted. Missing
likes/comments cannot support an engagement rate. Do not silently activate a
paid proxy fallback to fill absent fields.

## Repeat comparison, only if you choose to run again

The Actor does not store persistent growth history or calculate cross-run deltas.
Retain the two exports yourself. Match identities first, and calculate a delta
only when both numeric counts are known. Subscriber counts parsed from rounded
labels yield approximate changes; zero change can hide movement. A negative
delta may reflect corrections/removals and is not automatically an error.

For the same `videoId`, a later view count minus an earlier view count is an
observed difference between timestamps, not private YouTube Analytics. Account
for rounding and source corrections. A video missing from a later bounded sample
does not prove deletion. No schedule is created by this task; any repeat run or
schedule requires your own choice and can incur charges.

## Handoff boundaries

State that data is public, source-dependent and a bounded sample. A channel's
self-reported country is not audience geography. Do not claim US audience share,
viewer demographics, watch time, retention, revenue, sponsorship prices, verified
emails, complete upload coverage, or affiliation with YouTube/Google. No new
source access test or profitability measurement accompanies this documentation
package. Respect source terms, privacy and copyright; do not use it for spam or
harassment.
