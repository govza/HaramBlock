# Cloud Predictions

Opt-in sharing of the predictions this install computes with the Shared Prediction Cache (Diwan),
and later receiving predictions other installs computed. Users read "mask" for a prediction and
"Install ID" for the Reporter ID. This page covers consent and the switch; the sender and the lookup
are not built yet.

## Consent state

One value in `browser.storage.local` under `cloudPredictionsConsent`: `unanswered` (default),
`declined` or `agreed`. "Agree" on the consent tab or switching on in Options gives `agreed`; "Not
now" or switching off gives `declined`. There is no paused state, and off deletes nothing, locally
or on the server.

Code: `utils/cloudPredictions/` (`agree`, `decline`, `declineIfDataCollectionRevoked`, `getConsent`,
`getReporterId`, `isOn`, `getCloudPredictionsStatus`, `onCloudPredictionsChange`).

- **`isOn()`** is the single gate for reports and lookups. It holds when the state is `agreed` and,
  on Firefox, both optional data-collection types (`browsingActivity`, `websiteContent`) are
  granted. Its conditions are a list (`isOnGates`), so a new one (the configured server URL) is
  added there without touching callers.
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

## Manifest

`alarms` permission (for the sender), and on Firefox
`data_collection_permissions: { required: ['none'], optional: ['browsingActivity', 'websiteContent'] }`.

## E2E

`tests/e2e/features/cloud-predictions.feature`, tagged `@cloud`. The WDIO `before` hooks close the
consent tab the install opens (`tests/e2e/utils/consent-tab.ts`), so it does not background the
window the steps drive.

The feature is a release gate on Chrome, not a merge gate. Firefox's data-type prompt blocks the
options switch, so switching on there is a manual release check.
