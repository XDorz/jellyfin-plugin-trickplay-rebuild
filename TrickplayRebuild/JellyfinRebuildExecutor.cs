using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Trickplay;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;

namespace Findroid.TrickplayRebuild;

public sealed class JellyfinRebuildExecutor(
    ILibraryManager library,
    ITrickplayManager trickplay,
    IServerConfigurationManager config) : IRebuildExecutor
{
    public Guid Resolve(Guid itemId, Guid? mediaSourceId, Guid userId)
    {
        var parent = library.GetItemById<Video>(itemId, userId)
            ?? throw new RebuildException(404, "video_not_found");
        var targetId = mediaSourceId ?? parent.Id;
        // A supplied source must belong to this video's versions, not an arbitrary library item.
        if (targetId != parent.Id && !parent.GetMediaSources(false).Any(source =>
                Guid.TryParse(source.Id, out var id) && id == targetId))
            throw new RebuildException(400, "invalid_media_source");
        var video = library.GetItemById<Video>(targetId, userId)
            ?? throw new RebuildException(404, "video_not_found");
        Validate(video);
        return video.Id;
    }

    private LibraryOptions Validate(Video video)
    {
        var version = typeof(ITrickplayManager).Assembly.GetName().Version;
        if (version is null || version.Major != 12 || version.Minor != 1)
            throw new RebuildException(503, "incompatible_server");
        var options = library.GetLibraryOptions(video);
        if (options is null || !options.EnableTrickplayImageExtraction)
            throw new RebuildException(422, "trickplay_disabled");
        if (video.IsFolder || !video.IsFileProtocol || video.IsPlaceHolder || video.IsShortcut ||
            !video.IsCompleteMedia || video.VideoType is VideoType.Iso or VideoType.Dvd or VideoType.BluRay ||
            !video.RunTimeTicks.HasValue || video.RunTimeTicks.Value < TimeSpan.FromMilliseconds(
                Math.Max(1000, config.Configuration.TrickplayOptions.Interval)).Ticks)
            throw new RebuildException(422, "unsupported_video");
        var source = video.GetMediaSources(false).FirstOrDefault(source =>
            Guid.TryParse(source.Id, out var id) && id == video.Id);
        if (source?.VideoStream is null || string.IsNullOrEmpty(source.Path) || !File.Exists(source.Path))
            throw new RebuildException(422, "media_unavailable");
        if (config.Configuration.TrickplayOptions.WidthResolutions.Length == 0)
            throw new RebuildException(422, "invalid_trickplay_settings");
        return options;
    }

    public async Task<bool> ExecuteAsync(Guid videoId, CancellationToken cancellationToken)
    {
        var video = library.GetItemById<Video>(videoId)
            ?? throw new RebuildException(404, "video_not_found");
        var options = Validate(video); // Revalidate after waiting, before the native destructive step.
        var source = video.GetMediaSources(false).First(source => Guid.Parse(source.Id) == video.Id);
        var widths = config.Configuration.TrickplayOptions.WidthResolutions
            .Select(width => 2 * (Math.Min(width, source.VideoStream.Width ?? width) / 2))
            .Distinct().ToArray();

        // This is the only mutating Jellyfin call: never QueueRefresh/RefreshMetadata.
        await trickplay.RefreshTrickplayDataAsync(video, true, options, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();

        // The native implementation logs/swallow some failures, so a completed Task is not proof.
        var resolutions = await trickplay.GetTrickplayResolutions(videoId).ConfigureAwait(false);
        foreach (var width in widths)
        {
            if (!resolutions.TryGetValue(width, out var info) || info.ThumbnailCount <= 0 ||
                info.TileWidth <= 0 || info.TileHeight <= 0 || info.Interval <= 0) return false;
            var count = (int)Math.Ceiling((double)info.ThumbnailCount / info.TileWidth / info.TileHeight);
            for (var index = 0; index < count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var path = await trickplay.GetTrickplayTilePathAsync(video, width, index, options.SaveTrickplayWithMedia)
                    .ConfigureAwait(false);
                if (string.IsNullOrEmpty(path) || !File.Exists(path) || new FileInfo(path).Length == 0) return false;
            }
        }
        return widths.Length > 0;
    }
}
