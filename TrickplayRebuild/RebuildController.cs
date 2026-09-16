using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Findroid.TrickplayRebuild;

[ApiController]
[Route("TrickplayRebuild/Items")]
[Authorize(Policy = Policies.RequiresElevation)]
[ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public sealed class RebuildController(
    RebuildQueue queue,
    IRebuildExecutor executor,
    ILogger<RebuildController> logger) : ControllerBase
{
    [HttpPost("{itemId:guid}")]
    [RequestSizeLimit(1024)]
    public IActionResult Submit(Guid itemId, [FromQuery] Guid? mediaSourceId)
        => Handle(itemId, mediaSourceId, submit: true);

    [HttpGet("{itemId:guid}")]
    public IActionResult Status(Guid itemId, [FromQuery] Guid? mediaSourceId)
        => Handle(itemId, mediaSourceId, submit: false);

    private IActionResult Handle(Guid itemId, Guid? mediaSourceId, bool submit)
    {
        // Same claim used by Jellyfin's ClaimsPrincipalExtensions.GetUserId.
        // Require an actual logged-in user; anonymous and server-wide API keys are not accepted.
        if (!Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var userId) || userId == Guid.Empty)
            return Forbid();
        if (itemId == Guid.Empty || mediaSourceId == Guid.Empty)
            return BadRequest(new { code = "invalid_id" });
        try
        {
            var videoId = executor.Resolve(itemId, mediaSourceId, userId);
            return submit ? StatusCode(202, queue.Submit(videoId, userId)) : Ok(queue.Get(videoId));
        }
        catch (RebuildException ex)
        {
            if (ex.Status == 429) Response.Headers.RetryAfter = "60";
            return StatusCode(ex.Status, new { code = ex.Code });
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Trickplay request failed for {ItemId}", itemId);
            return StatusCode(500, new { code = "internal_error" });
        }
    }
}
