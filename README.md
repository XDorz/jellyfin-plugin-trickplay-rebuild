# Trickplay Rebuild / 单视频预览图重建

Small Jellyfin plugin for the matching [Findroid custom build](https://github.com/XDorz/findroid). It calls the native
Trickplay generator directly, using the server's existing settings, without
running the metadata refresh pipeline. No Jellyfin services are replaced and no
native scheduled tasks are changed.

## Install on LinuxServer Jellyfin

This build supports **Jellyfin 12.0 and 12.1 / .NET 10**, compiled against 12.0. Check the running server version in
the dashboard; the Docker `latest` tag alone does not identify the installed version.

1. Download `trickplay-rebuild-jellyfin-12.0-12.1.zip` and verify it using the published
   `SHA256SUMS` (the checksum detects download corruption, not publisher compromise).
2. Extract the `TrickplayRebuild` directory into `/config/data/plugins/` inside the
   container. With an existing compose volume `./jellyfin:/config`, that is
   `./jellyfin/data/plugins/TrickplayRebuild/` on the host.
3. Ensure the container's configured PUID/PGID can read the DLL and read/write the
   plugin directory and manifest. Restart Jellyfin and check the plugin dashboard.
4. Enable Trickplay extraction for the video library and use an administrator
   account in Findroid. Open a movie/episode and tap **重建预览图**.

No extra port, plugin catalog, database, server API key or Docker image is required.
When upgrading from 1.0.0.0, stop Jellyfin and replace both the DLL and `meta.json`
in the existing plugin directory. Do not leave a second copy of the old plugin.
After restarting, the dashboard should show **1.0.1.0**. The existing Findroid APK
works with this update; no server upgrade is needed for Jellyfin 12.0.
To remove: stop Jellyfin, remove this plugin directory, and restart. Generated
previews remain. Test compatibility before upgrading Jellyfin.

## API and behavior

Both routes require Jellyfin's `RequiresElevation` policy **and a user identity**.
Use the existing Jellyfin Authorization header; do not put credentials in URLs.

- `POST /TrickplayRebuild/Items/{itemId}?mediaSourceId={optionalGuid}`: 202 accepted;
  409 already queued/running; 429 rate limited/queue full; 422 unsupported media or
  extraction disabled. A source must be a version of the requested video.
- `GET /TrickplayRebuild/Items/{itemId}?mediaSourceId={optionalGuid}`: current plugin
  state (`none`, `queued`, `running`, `completed`, `failed`, `interrupted`).
- JSON fields: `apiVersion` (1), `instanceId`, actual video `itemId`, `jobId`, `state`,
  `updatedAt`. `instanceId` changes after a server restart; `none` is not success.
- One plugin worker, 20 waiting videos, at most 6 accepted/queue-capacity attempts
  per minute per user. Deduplication is atomic and spans users.
- No timeout releases an active reservation. It is released only when the awaited
  native method terminates. Results expire after 10 minutes; at most 128 are kept.
- The HTTP connection can close after submission without canceling the server job.
  Server shutdown cancels owned work; memory-only jobs are not replayed after restart.
- Native code swallows some errors. Completion therefore additionally checks the
  expected resolutions, index records and nonempty tile files.

The native generator deletes old previews **before** generating replacements. A
failure may leave no previews. Plugin deduplication does not coordinate with native
scans/scheduled jobs; concurrent work on the same video can collide. This is an
accepted limitation of keeping the plugin isolated. No automatic retries.

Findroid shows brief bottom messages for submission, duplicate requests, permission
errors and failures. It polls every 10 seconds only while the details page is resumed
and a plugin task is active. Online playback fetches previews for the selected media
source; invalidation removes only that source's downloaded preview cache/index,
never its downloaded video. Offline previews may need downloading again afterward.

## Security boundary

No unauthenticated execution route, custom login, shell invocation, user-supplied
filesystem path, network URL or FFmpeg arguments. Native Jellyfin authorization
remains authoritative even if cached client permissions are stale. Queue and history
are bounded. Expected failures return fixed codes; exceptions are logged locally.
The plugin runs inside Jellyfin with Jellyfin's privileges, not in a sandbox.
It does not protect against a compromised administrator token or vulnerabilities in
the server/media decoder. Keep the host and Jellyfin updated.

## Build and tests

```sh
dotnet test TrickplayRebuild.Tests -c Release
```

The plugin workflow publishes the DLL/manifest ZIP separately from the signed APK.
Each successful run gets a new versioned release tag, so updating the build workflow
does not require rewriting an old tag or granting a long-lived credential to CI.
Tests cover concurrent duplicate submissions, rate/queue bounds, jobs exceeding
10 minutes, failure recovery, shutdown, HTTP authorization and malformed IDs.

## 源码调查结论

- 原生 Trickplay 计划任务调用 `replace=false`，复用已有数据，不是每天强制覆盖。
- 扫描期间的 Trickplay Provider 受媒体库“扫描时提取”设置影响。Web 的覆盖选项
  走元数据刷新；本插件直接调用 `ITrickplayManager`，绕开该流程。
- 新入库、定时扫描、实时文件监控、自动刷新周期到期及手动/API 操作都可能进入
  元数据刷新流程。扫描不等于每次联网重刮；已有 NFO 也不保证不联网补充。
- 专用外部刮削库可关闭不需要的在线元数据/图片提供器，保留 NFO 和本地图片。
  本插件不修改这些设置。
- Jellyfin 内置影视源包括 TMDb、OMDb，并非自动搜索所有网站。Getchu/FANZA/DMM
  需要第三方提供器或外部 NFO。MetaTube 有 `dl.getchu.com` 和 FANZA/DMM 视频相关
  实现，不代表支持这些站点所有商品类型，也不代表已验证当前版本兼容性。

Source references:
[generator](https://github.com/jellyfin/jellyfin/blob/v12.1/Jellyfin.Server.Implementations/Trickplay/TrickplayManager.cs),
[scheduled task](https://github.com/jellyfin/jellyfin/blob/v12.1/MediaBrowser.Providers/Trickplay/TrickplayImagesTask.cs),
[metadata pipeline](https://github.com/jellyfin/jellyfin/blob/v12.1/MediaBrowser.Providers/Manager/MetadataService.cs),
[Getchu](https://github.com/metatube-community/metatube-sdk-go/blob/main/provider/getchu/getchu.go),
[FANZA](https://github.com/metatube-community/metatube-sdk-go/blob/main/provider/fanza/fanza.go).

The plugin was extracted from the XDorz/findroid fork into this repository for independent releases.
