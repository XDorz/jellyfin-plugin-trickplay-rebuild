# Validation — 2026-09-16

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
