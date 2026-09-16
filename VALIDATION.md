# Validation — 2026-09-16

## Jellyfin Web userscript 1.0.1

18 Chromium browser tests pass locally and cover native button placement, selected
media versions, administrator visibility, duplicate submissions, HTTP error toasts,
uncertain POSTs without retries, polling completion/background pause, SPA cleanup,
account changes, subpaths, cross-origin refusal and repeated script loading.

Installed the checksum-verified official Jellyfin Web 12.0 package alongside an
isolated official Jellyfin 12.0 server and server plugin 1.0.1.0. Signed in through
the real Web login page and injected the same userscript into its detail page.
Verified:

- The added button inherits the same computed color, background, radius, padding,
  font size and height as a visible native detail button.
- Clicking sends an authenticated POST accepted with 202 and calls the real native
  toast for submission, duplicate clicks and completed generation.
- Native generation completes; status is placed in the content flow below the
  ribbon, so it does not displace the action buttons or title.
- Desktop and emulated Pixel 7 layouts render correctly, without browser page errors.
- The relevant detail-page, toast, dashboard and styling files are unchanged
  between the v12.0 and v12.1 Web source tags.

Screenshots are in `web/screenshots/`. The synthetic fixture has no production media.
The browser test injects the script into the page; extension installation and real
mobile-device behavior were not exercised. Only Chromium was tested.

## Plugin 1.0.1: Jellyfin 12.0 and 12.1 compatibility regression

The 1.0.0 build incorrectly required Jellyfin 12.1 in its package references,
manifest and runtime guard. A fresh official 12.0 server skipped this plugin and
returned HTTP 404 for its routes. A loaded instance would also reject 12.0 with
`503 incompatible_server`. An Active entry in the plugin dashboard was therefore
not sufficient evidence that the rebuild endpoint worked.

Compared the v12.0/v12.1 native Trickplay interface, implementation, Video entity
and Trickplay options: these files are identical. The plugin now compiles against
12.0, declares target ABI 12.0 and allows the two verified server versions.

Ran the 14 automated tests with both 12.0 and 12.1 dependencies. Also started
separate official portable 12.0 and 12.1 servers on loopback only, with fresh
databases and synthetic media. On 12.0, reproduced the old plugin's HTTP 404,
then replaced its DLL and manifest in the same directory and restarted.
On both servers, the updated plugin was registered as 1.0.1.0 and verified:

- Unauthenticated rebuild rejected (401); administrator request accepted (202).
- Duplicate submission rejected (409); status reached completed.
- A second rebuild replaced existing native preview tiles.
- Movie metadata from the same details endpoint and the NFO checksum stayed identical.

Both temporary servers were stopped after testing. No production library was used.
Findroid now distinguishes 404, 405 and 503 in its user-facing error messages.

## Local Jellyfin 12.1 integration

Started the official portable Jellyfin 12.1 release with an isolated database,
configuration and synthetic 60-second video, listening only on 127.0.0.1.
Installed the built plugin using its DLL and meta.json. No production server or
user library was contacted or modified.

Verified:

- Jellyfin discovers the plugin and starts its hosted worker.
- An unauthenticated POST receives 401.
- A real non-administrator Jellyfin account receives 403 for GET and POST.
- A logged-in administrator submits successfully (202); a duplicate while the
  job is active receives 409.
- Arbitrary/unrelated media-source IDs and path-like query values receive 400.
- The worker runs the real native FFmpeg/Trickplay pipeline and reaches completed.
- Repeating the request after completion overwrites the existing tile files
  (new modification times), rather than simply accepting old files.
- The NFO SHA-256 stays identical. Item metadata read from the same details
  endpoint before/after stays identical: title, original title, overview, external
  IDs, genres, people, tags, year, official rating and premiere date.
- Changing the test server's native settings to 160-pixel width and a 2-second
  interval produces exactly those values in the generated manifest.
- With two grouped versions, selecting the alternate source generates previews
  only for that source; the other version remains untouched.

## Automated coverage

14 .NET tests cover atomic duplicate handling across users, queue/rate bounds,
live reservations beyond 10 minutes, release after failures, a failed native
result, cancellation/shutdown, HTTP authorization, malformed IDs and no-store
status responses.

The Android data regression test uses the compact GUID / omitted-null response
observed from this server. Android compilation checks the Compose/Hilt integration.
The signed release workflow runs this regression test before packaging the APK.

## Limits

No physical-phone UI test was performed. Concurrent native Jellyfin jobs are
deliberately not intercepted or coordinated. The fixture uses a local MP4;
hardware acceleration, network storage, other Jellyfin versions and other media
formats need environment-specific verification. A plugin exception is contained,
but this cannot guarantee protection from server/FFmpeg faults or resource exhaustion.
