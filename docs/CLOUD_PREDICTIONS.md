# Cloud Predictions

Opt-in sharing of the predictions this install computes with the Shared Prediction Cache (Diwan),
and later receiving predictions other installs computed. Users read "mask" for a prediction and
"Install ID" for the Reporter ID. This page covers consent, the switch, the eligibility filter, the
Report Status of cached records, and the server configuration and the client seam; the real client,
the sender and the lookup are not built yet.

## Consent state

One value in `browser.storage.local` under `cloudPredictionsConsent`: `unanswered` (default),
`declined` or `agreed`. "Agree" on the consent tab or switching on in Options gives `agreed`; "Not
now" or switching off gives `declined`. There is no paused state, and off deletes nothing, locally
or on the server.

Code: `utils/cloudPredictions/` (`agree`, `decline`, `declineIfDataCollectionRevoked`, `getConsent`,
`getReporterId`, `isOn`, `getCloudPredictionsStatus`, `onCloudPredictionsChange`).

- **`isOn()`** is the single gate for reports and lookups. It holds when the state is `agreed`, the
  build has a server URL (`IS_CLOUD_PREDICTIONS_SERVER_CONFIGURED`) and, on Firefox, both optional
  data-collection types (`browsingActivity`, `websiteContent`) are granted. Its conditions are a
  list (`isOnGates`), so a new one is added there without touching callers.
- **Firefox.** `agree()` first calls `permissions.request({ data_collection: [...] })`, so it must
  be the first call of the click handler to keep the user gesture. A refusal leaves the stored state
  unchanged. Revoking either type in about:addons makes `isOn()` false at once, and the background
  (`events/dataCollectionListener.ts`, on the permission change and at startup) then stores
  `declined`, so granting the type back there does not switch reporting on: only an agree click
  does. Chrome has no prompt.
- **Reporter ID.** A random UUID under `cloudPredictionsReporterId`, created at the first agree,
  stable across off and on, never reset. Shown with a copy button in Options whenever it exists;
  "Ask us to delete them" is a prefilled `mailto:` carrying it.
- **Subscription.** `onCloudPredictionsChange(listener)` calls back when the stored state or a
  Firefox data-collection grant changes; the listener reads what it needs.

## Consent tab

`entrypoints/consent/` (`consent.html`), one screen with the agreed wording. The background opens it
from `runtime.onInstalled` on install, and on the first update that carries it, while the state is
`unanswered` (`openConsentTabIfDue`). `cloudPredictionsConsentTabShown` records that it opened, so
it never opens on its own twice. Either answer closes the tab; a refused Firefox prompt leaves it
open.

A tab closed without an answer leaves the state `unanswered`, which behaves as `declined`: off, and
never asked again. The options switch is the way back in.

## Options section

Its own "Cloud Predictions" tab on the options page
(`entrypoints/options/features/CloudPredictions.tsx`) with three worded states: never agreed (no
Install ID yet), on, and off after having agreed. Switching on there is the agree click; the consent
tab is not shown again. Nothing is in the popup.

## Eligibility filter

`utils/cloudPredictions/eligibility.ts`: the one pure answer to "may this media be shared", for the
sender (`isEligibleForReport`) and the lookup (`isEligibleForLookup`). It reads syntax and record
facts only: no DNS, no network, no settings. Host policy is not an input.

- **Media URL.** Rejected when it is not `http(s)`, carries userinfo, or its host is `localhost`, an
  IP literal in a private range (loopback, RFC 1918, link-local, carrier-grade NAT, unspecified,
  IPv6 unique-local, link-local and site-local, and IPv6 forms that embed a private IPv4 address:
  mapped, translated, NAT64), single-label, or ends in `.local`, `.internal`, `.lan`, `.home.arpa`
  or `.localhost`. A public name that resolves to a private address passes: nothing is resolved.
  Query strings and unknown tokens do not reject.
- **Page hostname.** The same host test.
- **Never shared.** GIFs (by `.gif` extension or `image/gif` content type) and videos whose identity
  is not `stable` (`page:` and unknown). A `url:` video identity also passes the media URL test.
- **Report only.** An image whose `Cache-Control` has `private`, `no-store`, `no-cache` or
  `max-age=0` is not reported; the header is unknown at lookup time, so it is still looked up. The
  record's `cacheMetadata.cacheControl` is the image response's own header, read where the image is
  fetched (`fetchCachedMedia`), and absent when the site sent none. A record whose `modelId` is
  missing, `'unknown'` or not in the caller's set of shipped ids is not reported. The caller builds
  that set in the form the record uses: bare ids for image rows, `<id>@<version>` for video buckets.

Incognito Tabs are not this filter's business: their media never reaches the cache.

## Report Status and provenance (schema v5)

Image rows (`imagePredictions`) and video sample buckets (`videoSampleBuckets`) carry
`IReportTracking`:

- `provenance: 'own' | 'served'` and `servedAt?`. Everything written today is `'own'`; served
  records arrive with the lookup release. Provenance is part of the video bucket key.
- `reportStatus?: 'pending' | 'reported' | 'rejected'` and `reportChangedAt?`, the time the record
  last changed in a way a report carries. Both tables index `[reportStatus+reportChangedAt]`, the
  one index every sender query uses.

No status means never reported. The rules, all applied where the row is written:

- **`storeOwn`** decides eligibility once, in the cache service (`isEligibleForReport` with
  `shippedModelIds()`, which holds both id forms). An eligible image row is `pending`; a rejected
  one has no status. A video bucket becomes `pending` when the write changed its samples, keeps its
  status when the write added nothing, and loses it when the write is not eligible.
- **`setForcedVisibility`** re-reports only on a real flip, and only a record that already has a
  status: an image row goes back to `pending`; a video marks its earliest bucket that has a status,
  and nothing when it has none (the first bucket stored later is `pending` anyway and is reported
  with the meta row's toggle). A bucket without a status is skipped on purpose: the filter rejected
  it when it was written (say, on a private-host page) or it was served, so it has no
  `reportHostname` and must not be sent. The toggle belongs to the video, the bucket only carries
  it, so the next bucket that passed the filter carries it instead.
- **`touch` and `rehome`** never change the status.
- **`reportHostname`.** A record's `hostname` follows the last page the media was seen on: `rehome`
  moves an image row's, and every video `storeOwn` moves the bucket's and the meta row's, even when
  it adds no samples. So a record that becomes `pending` in `storeOwn` also gets `reportHostname`,
  the page hostname that passed the filter, and keeps it for as long as it keeps its status. A
  report carries `reportHostname`, never `hostname`: a later private-host page is never sent.
- **Migrated rows.** v4 image rows are kept as `'own'` with no status, so they are never reported,
  toggled or not: their `cacheControl` may be a synthesised value. v4 video buckets are dropped.

Both cache services call the listener given to `setOnReportPending` whenever a record became
`pending`; the sender will create its alarm on it. Nothing is sent yet.

Tests run these rules and the v4 → v5 migration against real Dexie on `fake-indexeddb`
(`utils/db/__tests__/`).

## Server configuration

Where the Shared Prediction Cache is, and whether a build reports, is decided at build time. Nothing
is fetched from the server for configuration: no remote off switch, no config endpoint.

- **`WXT_CLOUD_PREDICTIONS_URL`**: the server URL. `wxt.config.ts` reads it and bakes it in as
  `__HB_CLOUD_PREDICTIONS_URL__`, which only `utils/cloudPredictions/config.ts` reads. The address
  itself (`CLOUD_PREDICTIONS_URL`) is for the client module alone; everything else, `isOn()`
  included, asks `IS_CLOUD_PREDICTIONS_SERVER_CONFIGURED`. There is no default: a build without it
  fails. Outside development mode it must be `https://`. A development build may use `http://` (a
  local Diwan) or leave it empty, which keeps `isOn()` false.
- **`WXT_CLOUD_PREDICTIONS_REPORT`**: `true` or `false`, anything else fails the build. Baked in as
  `__HB_CLOUD_PREDICTIONS_REPORT__` (`IS_CLOUD_PREDICTIONS_REPORT_ENABLED`). `false` stops this
  build reporting and leaves lookups; set it while running unshipped inference changes. Never a user
  setting.
- **Env files.** `.env.development` and `.env.production` are committed, both with
  `https://api.haramblock.com` and reporting on, so `pnpm dev` and E2E talk to production. Vite lets
  a mode file win over `.env` and `.env.local`, so overrides go in `.env.development.local` /
  `.env.production.local` (ignored) or a non-empty process environment value (an empty one loses to
  the file). `.env.production` is added to the Firefox sources ZIP (`zip.includeSources`), since the
  reviewer's rebuild fails without it.
- The rules are `resolveCloudPredictionsBuildConfig` (`scripts/cloudPredictionsBuildConfig.ts`).
  Vitest defines the two constants itself (`vitest.config.ts`).

## Client seam

`ICloudPredictionsClient` (`utils/types/cloudPredictionsClient.ts`) is the one way background
services talk to the server: `reportImages` (`POST /api/image-reports`), `reportVideo`
(`POST /api/video-reports`, one bucket) and `lookUpPredictions` (`POST /api/prediction-lookups`,
hits only). Each takes an optional `AbortSignal` and resolves to a typed outcome, never throwing:

| Outcome      | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `ok`         | accepted; a lookup carries its `hits`                              |
| `rejected`   | the server refused the request for good (400)                      |
| `retryAfter` | the server asked for a pause (429), with `retryAfterMs`            |
| `failed`     | network error, server error or an aborted call: retry with backoff |

The request and hit shapes are hand-written until Diwan's OpenAPI document exists; the real client
then types them from `openapi-typescript` output. An image hit carries no hostname and no Forced
Visibility: other users' toggles are never received. No real client exists yet.

Service tests use `FakeCloudPredictionsClient`
(`utils/cloudPredictions/testing/fakeCloudPredictionsClient.ts`): it records calls, accepts reports,
answers lookups from `serve(hit)`, fails the next calls with `failNext(...)`, and holds calls
between `stall()` and `release()` (an aborted held call is `failed`).

## Timings

Every Cloud Predictions timing and cap is a named constant in `utils/cloudPredictions/timings.ts`,
changed by a release only.

| Constant                                              | Value        |
| ----------------------------------------------------- | ------------ |
| `REPORT_FLUSH_INTERVAL_MS` ± `REPORT_FLUSH_JITTER_MS` | 60 s ± 30 s  |
| `VIDEO_BUCKET_QUIET_MS`                               | 2 min        |
| `IMAGE_REPORTS_PER_FLUSH` / `VIDEO_REPORTS_PER_FLUSH` | 200 / 10     |
| `LOOKUP_BATCH_WINDOW_MS` / `LOOKUP_BATCH_SIZE`        | 100 ms / 100 |
| `LOOKUP_TIMEOUT_MS`                                   | 3 s          |
| `BACKOFF_CEILING_MS`                                  | 1 h          |
| `RETRY_AFTER_CAP_MS`                                  | 24 h         |
| `SERVED_LIFETIME_MS`                                  | 7 days       |

## Manifest

`alarms` permission (for the sender), and on Firefox
`data_collection_permissions: { required: ['none'], optional: ['browsingActivity', 'websiteContent'] }`.

## E2E

`tests/e2e/features/cloud-predictions.feature`, tagged `@cloud`. The WDIO `before` hooks close the
consent tab the install opens (`tests/e2e/utils/consent-tab.ts`), so it does not background the
window the steps drive.

The feature is a release gate on Chrome, not a merge gate. Firefox's data-type prompt blocks the
options switch, so switching on there is a manual release check.
