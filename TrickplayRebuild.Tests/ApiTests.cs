using System.Net;
using System.Security.Claims;
using System.Text.Encodings.Web;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Xunit;

namespace Findroid.TrickplayRebuild.Tests;

public sealed class TestAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger, UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var role = Request.Headers["Test-Role"].ToString();
        if (string.IsNullOrEmpty(role)) return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(ClaimTypes.Role, role) };
        if (Request.Headers["Test-Api-Key"] != "true")
            claims.Add(new Claim("Jellyfin-UserId", "aa57a8b9-3d8c-4c8c-b0a0-07a349db2f93"));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(
            new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}

public sealed class ApiTests
{
    private static TestServer Create() => new(new WebHostBuilder()
        .ConfigureServices(services =>
        {
            services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, TestAuthentication>("test", _ => { });
            services.AddAuthorization(options => options.AddPolicy(Policies.RequiresElevation,
                policy => policy.RequireAuthenticatedUser().RequireRole("Administrator")));
            services.AddSingleton(TimeProvider.System);
            services.AddSingleton<IRebuildExecutor, FakeExecutor>();
            services.AddSingleton<RebuildQueue>();
            services.AddControllers().AddApplicationPart(typeof(RebuildController).Assembly);
        })
        .Configure(app =>
        {
            app.UseRouting();
            app.UseAuthentication();
            app.UseAuthorization();
            app.UseEndpoints(endpoints => endpoints.MapControllers());
        }));

    [Theory]
    [InlineData(null, HttpStatusCode.Unauthorized)]
    [InlineData("User", HttpStatusCode.Forbidden)]
    public async Task BothEndpointsRequireAdministrator(string? role, HttpStatusCode expected)
    {
        using var server = Create();
        using var client = server.CreateClient();
        if (role is not null) client.DefaultRequestHeaders.Add("Test-Role", role);
        var url = "/TrickplayRebuild/Items/" + Guid.NewGuid();
        Assert.Equal(expected, (await client.GetAsync(url)).StatusCode);
        Assert.Equal(expected, (await client.PostAsync(url, null)).StatusCode);
    }

    [Fact]
    public async Task ServerApiKeyWithoutUserIsRejected()
    {
        using var server = Create();
        using var client = server.CreateClient();
        client.DefaultRequestHeaders.Add("Test-Role", "Administrator");
        client.DefaultRequestHeaders.Add("Test-Api-Key", "true");
        Assert.Equal(HttpStatusCode.Forbidden,
            (await client.PostAsync("/TrickplayRebuild/Items/" + Guid.NewGuid(), null)).StatusCode);
    }

    [Fact]
    public async Task AcceptedAndDuplicateAreDistinctAndStatusIsNotCached()
    {
        using var server = Create();
        using var client = server.CreateClient();
        client.DefaultRequestHeaders.Add("Test-Role", "Administrator");
        var url = "/TrickplayRebuild/Items/" + Guid.NewGuid();
        var accepted = await client.PostAsync(url, null);
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        Assert.Contains("\"apiVersion\":1", await accepted.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync(url, null)).StatusCode);
        var status = await client.GetAsync(url);
        Assert.True(status.Headers.CacheControl?.NoStore);
        Assert.Contains("\"state\":\"queued\"", await status.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("00000000-0000-0000-0000-000000000000", "")]
    [InlineData("aa57a8b9-3d8c-4c8c-b0a0-07a349db2f93", "?mediaSourceId=../../etc/passwd")]
    public async Task InvalidIdsCannotEnterQueue(string id, string query)
    {
        using var server = Create();
        using var client = server.CreateClient();
        client.DefaultRequestHeaders.Add("Test-Role", "Administrator");
        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.PostAsync("/TrickplayRebuild/Items/" + id + query, null)).StatusCode);
    }
}
