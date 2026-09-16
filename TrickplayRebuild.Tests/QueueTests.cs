using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Findroid.TrickplayRebuild.Tests;

public sealed class FakeClock : TimeProvider
{
    public DateTimeOffset Now = DateTimeOffset.UtcNow;
    public override DateTimeOffset GetUtcNow() => Now;
}

public sealed class FakeExecutor : IRebuildExecutor
{
    public Func<Guid, CancellationToken, Task<bool>> Execute = (_, _) => Task.FromResult(true);
    public Guid Resolve(Guid itemId, Guid? mediaSourceId, Guid userId) => mediaSourceId ?? itemId;
    public Task<bool> ExecuteAsync(Guid videoId, CancellationToken cancellationToken) => Execute(videoId, cancellationToken);
}

public sealed class QueueTests
{
    private readonly FakeClock _clock = new();
    private readonly FakeExecutor _executor = new();
    private RebuildQueue Create() => new(_executor, _clock, NullLogger<RebuildQueue>.Instance);

    [Fact]
    public async Task ConcurrentSubmissionsAcrossUsersAcceptExactlyOne()
    {
        using var queue = Create();
        var id = Guid.NewGuid();
        var results = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => Task.Run(() =>
        {
            try { queue.Submit(id, Guid.NewGuid()); return 202; }
            catch (RebuildException ex) { return ex.Status; }
        })));
        Assert.Equal(1, results.Count(status => status == 202));
        Assert.Equal(49, results.Count(status => status == 409));
    }

    [Fact]
    public void MoreThanTenMinutesDoesNotUnlockQueuedOrRunningJob()
    {
        using var queue = Create();
        var id = Guid.NewGuid();
        queue.Submit(id, Guid.NewGuid());
        _clock.Now += TimeSpan.FromHours(3);
        Assert.True(queue.Get(id).Active);
        Assert.Equal(409, Assert.Throws<RebuildException>(() => queue.Submit(id, Guid.NewGuid())).Status);
    }

    [Fact]
    public void QueueIsBoundedAndRejectedItemIsNotReserved()
    {
        using var queue = Create();
        for (var i = 0; i < 20; i++) queue.Submit(Guid.NewGuid(), Guid.NewGuid());
        var id = Guid.NewGuid();
        Assert.Equal("queue_full", Assert.Throws<RebuildException>(() => queue.Submit(id, Guid.NewGuid())).Code);
        Assert.Equal("none", queue.Get(id).State);
    }

    [Fact]
    public void UserRateLimitExpiresWithoutExpiringJobs()
    {
        using var queue = Create();
        var user = Guid.NewGuid();
        for (var i = 0; i < 6; i++) queue.Submit(Guid.NewGuid(), user);
        Assert.Equal(429, Assert.Throws<RebuildException>(() => queue.Submit(Guid.NewGuid(), user)).Status);
        _clock.Now += TimeSpan.FromMinutes(1);
        Assert.Equal("queued", queue.Submit(Guid.NewGuid(), user).State);
    }

    [Fact]
    public async Task FailedJobReleasesReservationAndDoesNotStopWorker()
    {
        using var queue = Create();
        var fail = Guid.NewGuid();
        _executor.Execute = (id, _) => id == fail ? throw new IOException("test") : Task.FromResult(true);
        await queue.StartAsync(CancellationToken.None);
        queue.Submit(fail, Guid.NewGuid());
        await Until(() => queue.Get(fail).State == "failed");
        var next = Guid.NewGuid();
        queue.Submit(next, Guid.NewGuid());
        await Until(() => queue.Get(next).State == "completed");
        Assert.Equal("queued", queue.Submit(fail, Guid.NewGuid()).State);
        await queue.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task NativeReturnWithoutVerifiedArtifactsIsFailure()
    {
        using var queue = Create();
        _executor.Execute = (_, _) => Task.FromResult(false);
        await queue.StartAsync(CancellationToken.None);
        var id = Guid.NewGuid();
        queue.Submit(id, Guid.NewGuid());
        await Until(() => queue.Get(id).State == "failed");
        await queue.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task RunningJobRemainsReservedUntilAwaitCompletes()
    {
        using var queue = Create();
        var finish = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _executor.Execute = (_, ct) => finish.Task.WaitAsync(ct);
        await queue.StartAsync(CancellationToken.None);
        var id = Guid.NewGuid();
        queue.Submit(id, Guid.NewGuid());
        await Until(() => queue.Get(id).State == "running");
        _clock.Now += TimeSpan.FromHours(1);
        Assert.Equal(409, Assert.Throws<RebuildException>(() => queue.Submit(id, Guid.NewGuid())).Status);
        finish.SetResult(true);
        await Until(() => queue.Get(id).State == "completed");
        _clock.Now += TimeSpan.FromMinutes(11);
        Assert.Equal("none", queue.Get(id).State);
        await queue.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ShutdownCancelsOwnedWorkAndRejectsSubmissions()
    {
        using var queue = Create();
        _executor.Execute = async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return true; };
        await queue.StartAsync(CancellationToken.None);
        var id = Guid.NewGuid();
        queue.Submit(id, Guid.NewGuid());
        await Until(() => queue.Get(id).State == "running");
        await queue.StopAsync(CancellationToken.None);
        Assert.Equal("interrupted", queue.Get(id).State);
        Assert.Equal(503, Assert.Throws<RebuildException>(() => queue.Submit(Guid.NewGuid(), Guid.NewGuid())).Status);
    }

    internal static async Task Until(Func<bool> predicate)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!predicate()) await Task.Delay(10, deadline.Token);
    }
}
