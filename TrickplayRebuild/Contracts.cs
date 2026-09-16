using System.Text.Json.Serialization;

namespace Findroid.TrickplayRebuild;

public sealed record RebuildStatus(
    [property: JsonPropertyName("instanceId")] Guid InstanceId,
    [property: JsonPropertyName("itemId")] Guid ItemId,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("jobId")] Guid? JobId = null,
    [property: JsonPropertyName("updatedAt")] DateTimeOffset? UpdatedAt = null)
{
    [JsonPropertyName("apiVersion")]
    public int ApiVersion => 1;

    [JsonIgnore]
    public bool Active => State is "queued" or "running";
}

public sealed class RebuildException(int status, string code) : Exception(code)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public interface IRebuildExecutor
{
    Guid Resolve(Guid itemId, Guid? mediaSourceId, Guid userId);
    Task<bool> ExecuteAsync(Guid videoId, CancellationToken cancellationToken);
}
