using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Findroid.TrickplayRebuild;

public sealed class RebuildQueue(
    IRebuildExecutor executor,
    TimeProvider clock,
    ILogger<RebuildQueue> logger) : BackgroundService
{
    private readonly object _gate = new();
    private readonly Guid _instanceId = Guid.NewGuid();
    private readonly Dictionary<Guid, RebuildStatus> _jobs = [];
    private readonly Dictionary<Guid, Queue<DateTimeOffset>> _requests = [];
    private readonly Channel<Guid> _channel = Channel.CreateBounded<Guid>(new BoundedChannelOptions(20)
    {
        SingleReader = true,
        FullMode = BoundedChannelFullMode.Wait
    });
    private bool _stopping;

    public RebuildStatus Submit(Guid videoId, Guid userId)
    {
        lock (_gate)
        {
            Prune();
            if (_stopping) throw new RebuildException(503, "stopping");
            // Check and reserve under one lock, including submissions from different accounts.
            if (_jobs.TryGetValue(videoId, out var previous) && previous.Active)
                throw new RebuildException(409, "already_running");
            var now = clock.GetUtcNow();
            if (!_requests.TryGetValue(userId, out var requests))
            {
                if (_requests.Count >= 1024) throw new RebuildException(429, "rate_limited");
                _requests[userId] = requests = new Queue<DateTimeOffset>();
            }
            if (requests.Count >= 6) throw new RebuildException(429, "rate_limited");
            requests.Enqueue(now);
            var status = new RebuildStatus(_instanceId, videoId, "queued", Guid.NewGuid(), now);
            _jobs[videoId] = status;
            if (!_channel.Writer.TryWrite(videoId))
            {
                if (previous is null) _jobs.Remove(videoId);
                else _jobs[videoId] = previous;
                throw new RebuildException(429, "queue_full");
            }
            return status;
        }
    }

    public RebuildStatus Get(Guid videoId)
    {
        lock (_gate)
        {
            Prune();
            return _jobs.GetValueOrDefault(videoId) ?? new RebuildStatus(_instanceId, videoId, "none");
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var videoId in _channel.Reader.ReadAllAsync(stoppingToken))
            {
                SetState(videoId, "running");
                var outcome = "failed";
                try
                {
                    var verified = await executor.ExecuteAsync(videoId, stoppingToken).ConfigureAwait(false);
                    outcome = stoppingToken.IsCancellationRequested ? "interrupted" : verified ? "completed" : "failed";
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    outcome = "interrupted";
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Trickplay rebuild failed for {VideoId}", videoId);
                }
                finally
                {
                    // Terminal records don't block another request. No timer can release a live job.
                    SetState(videoId, outcome);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            lock (_gate)
            {
                _stopping = true;
                _channel.Writer.TryComplete();
                foreach (var id in _jobs.Where(pair => pair.Value.Active).Select(pair => pair.Key).ToArray())
                    _jobs[id] = _jobs[id] with { State = "interrupted", UpdatedAt = clock.GetUtcNow() };
            }
        }
    }

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            _stopping = true;
            _channel.Writer.TryComplete();
        }
        return base.StopAsync(cancellationToken);
    }

    private void SetState(Guid id, string state)
    {
        lock (_gate)
        {
            _jobs[id] = _jobs[id] with { State = state, UpdatedAt = clock.GetUtcNow() };
            Prune();
        }
    }

    private void Prune()
    {
        var now = clock.GetUtcNow();
        foreach (var pair in _requests.ToArray())
        {
            while (pair.Value.TryPeek(out var time) && now - time >= TimeSpan.FromMinutes(1))
                pair.Value.Dequeue();
            if (pair.Value.Count == 0) _requests.Remove(pair.Key);
        }
        var finished = _jobs.Values.Where(job => !job.Active).OrderByDescending(job => job.UpdatedAt).ToArray();
        for (var i = 0; i < finished.Length; i++)
            if (i >= 128 || now - finished[i].UpdatedAt >= TimeSpan.FromMinutes(10))
                _jobs.Remove(finished[i].ItemId);
    }
}
