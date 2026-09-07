using System.Net.Http.Json;
using Microsoft.AspNetCore.Http;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Services;
using Xunit;
namespace PiPlayer.Server.Tests;

public class RecoveryTests
{
    [Fact] public async Task CancelledStreamingUploadRemovesAnAlreadyCreatedPartialFile()
    {
        using var temp = new TempData(); using var cancellation = new CancellationTokenSource();
        var bytes = new byte[100000]; "ftyp"u8.CopyTo(bytes.AsSpan(4));
        using var form = new MultipartFormDataContent(); form.Add(new ByteArrayContent(bytes), "file", "cancel.mp4");
        var body = await form.ReadAsByteArrayAsync(); bool partialExisted = false;
        await using var stream = new CancelStream(body, () => { partialExisted = Directory.GetFiles(temp.Paths.Get("uploads")).Length > 0; cancellation.Cancel(); });
        var context = new DefaultHttpContext(); context.Request.Body = stream; context.Request.ContentType = form.Headers.ContentType!.ToString(); context.Request.ContentLength = body.Length;
        var library = new MediaLibrary(temp.Store, temp.Paths, new() { MinFreeDiskBytes = 0, MaxVideoUploadBytes = 200000 });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => library.Upload("videos",context.Request,cancellation.Token));
        Assert.True(partialExisted); Assert.Empty(Directory.GetFiles(temp.Paths.Get("uploads"))); Assert.Empty(Directory.GetFiles(temp.Paths.Get("media/videos")));
    }
    [Fact] public async Task InvalidResumeDocumentIsPreservedAndDefaultsRemainWritable()
    {
        using var app = new TestApp(); await app.Data.Store.Update<StartupSettings>("settings/startup-settings.json", _ => new() {StartupMode="resumeLast"});
        await File.WriteAllTextAsync(app.Data.Paths.Get("settings/runtime-state.json"),"not-json");
        using var client=await app.Admin(); var state=(await client.GetFromJsonAsync<StateEnvelope>("/api/system/state",Json.Options))!;
        Assert.Null(state.Desired.Visual.Source); Assert.NotEmpty(state.Warnings); Assert.Single(Directory.GetFiles(app.Data.Paths.Get("settings"),"runtime-state.json.invalid-*"));
        var command=new CommandEnvelope(Json.Id(),"visual","setTransform",System.Text.Json.JsonSerializer.SerializeToElement(new Transform(100,20),Json.Options),state.Revision,0);
        (await client.PostAsJsonAsync("/api/commands",command,Json.Options)).EnsureSuccessStatusCode();
        Assert.Equal("saved",(await client.GetFromJsonAsync<StateEnvelope>("/api/system/state",Json.Options))!.Persistence);
    }
    private sealed class CancelStream(byte[] data, Action cancel) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        { if (Position >= 32768) cancel(); return base.ReadAsync(buffer[..Math.Min(buffer.Length,4096)],cancellationToken); }
    }
}
