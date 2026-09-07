using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Services;
using Xunit;
namespace PiPlayer.Server.Tests;

public class RuntimeTests
{
    [Fact] public async Task LoadErrorFailsCommandBeforeConfigurationAcknowledgement()
    {
        using var app = new TestApp(); using var client = await app.Admin(); var runtime = app.Services.GetRequiredService<Runtime>(); var sessions = app.Services.GetRequiredService<ScreenSessions>(); var page = Json.Id(); sessions.Register("screen",new("primary",page,new(1280,720)));
        var before = await runtime.Snapshot(); var command = new CommandEnvelope(Json.Id(),"visual","setSource",JsonSerializer.SerializeToElement(new {source=(VisualSource)new YouTubeVideo("dQw4w9WgXcQ"),autoplay=true},Json.Options),before.Revision,0);
        await runtime.Dispatch(command,"admin"); var selected=await runtime.Snapshot();
        Assert.True(await runtime.Report("screen",new(page,selected.ServerInstanceId,"visual",1,new() {Status="error",SourceFingerprint=Validate.Fingerprint(selected.Desired.Visual.Source),PlaybackGeneration=1,LastAppliedRevision=0,Error=new("providerUnavailable","API unavailable")})));
        Assert.Equal("failed",(await runtime.Dispatch(command,"admin")).Status);
    }
    [Theory][InlineData(false,false)][InlineData(true,false)][InlineData(false,true)][InlineData(true,true)]
    public async Task StartupFlagsAreIndependentAndRegistrationNeverReappliesDefaults(bool visual, bool audio)
    {
        using var app = new TestApp(); var (v,a) = await Seed(app);
        await app.Data.Store.Update<StartupSettings>("settings/startup-settings.json", _ => new() { DefaultVisualPresetId = v, DefaultAudioPresetId = a, StartVisualOnBoot = visual, StartAudioOnBoot = audio });
        using var client = await app.Admin(); var runtime = app.Services.GetRequiredService<Runtime>(); var before = await runtime.Snapshot();
        Assert.Equal(visual, before.Desired.Visual.Source != null); Assert.Equal(audio, before.Desired.Audio.Source != null);
        var changed = new CommandEnvelope(Json.Id(), "system", "setBackground", JsonSerializer.SerializeToElement(new {color="#123456"}), before.Revision);
        await runtime.Dispatch(changed,"test"); var state = await runtime.Snapshot(); var sessions = app.Services.GetRequiredService<ScreenSessions>(); var descriptor = new ScreenDescriptor("primary",Json.Id(),new(1280,720));
        Assert.True(sessions.Register("one",descriptor)); Assert.Equal(state.Desired,(await runtime.Snapshot()).Desired); sessions.Disconnect("one"); Assert.True(sessions.Register("two",descriptor)); Assert.Equal("#123456",(await runtime.Snapshot()).Desired.Background.Color);
    }
    [Fact] public async Task ResumeLastIgnoresBootFlagsAndRetainsMatchingCheckpoints()
    {
        using var app = new TestApp();
        await app.Data.Store.Update<StartupSettings>("settings/startup-settings.json", _ => new() {StartupMode="resumeLast",StartAudioOnBoot=false,StartVisualOnBoot=false});
        var state = new DesiredState { Visual = new() { Source=new YouTubeVideo("dQw4w9WgXcQ"),Transport="paused",PlaybackGeneration=9 }, Audio = new() { Source=new RemoteAudioUrl("https://radio.example/stream","live"),Transport="playing",PlaybackGeneration=3 } };
        var checkpoint = new Checkpoint(Validate.Fingerprint(state.Visual.Source),9,44,100,false,null,null,DateTimeOffset.UtcNow);
        await app.Data.Store.Update<RuntimeDocument>("settings/runtime-state.json", _ => new() { Desired=state,Checkpoints=new(checkpoint,null) });
        using var client = await app.Admin(); var snapshot = await client.GetFromJsonAsync<StateEnvelope>("/api/system/state",Json.Options);
        Assert.Equal(state,snapshot!.Desired); Assert.Equal(checkpoint,snapshot.Checkpoints.Visual); Assert.False(snapshot.Screen.Connected);
    }
    [Fact] public async Task ObservedRequiresCurrentSessionGenerationFingerprintAndSequence()
    {
        using var app = new TestApp(); using var client = await app.Admin(); var runtime = app.Services.GetRequiredService<Runtime>(); var sessions = app.Services.GetRequiredService<ScreenSessions>(); var page=Json.Id(); sessions.Register("screen",new("primary",page,new(1280,720)));
        var before=await runtime.Snapshot(); var command=new CommandEnvelope(Json.Id(),"visual","setSource",JsonSerializer.SerializeToElement(new { source=(VisualSource)new YouTubeVideo("dQw4w9WgXcQ"),autoplay=true },Json.Options),before.Revision,before.Desired.Visual.PlaybackGeneration);
        var receipt=await runtime.Dispatch(command,"admin"); Assert.Equal("accepted",receipt.Status); var state=await runtime.Snapshot(); Assert.Empty(state.Observed);
        var report=new PlaybackReport(page,state.ServerInstanceId,"visual",1,new() { Status="playing",SourceFingerprint=Validate.Fingerprint(state.Desired.Visual.Source),PlaybackGeneration=state.Desired.Visual.PlaybackGeneration,LastAppliedRevision=state.Revision,ActualMuted=true,ActualVolume=70,DurationSeconds=120,PositionSeconds=12 });
        Assert.False(await runtime.Report("old",report)); Assert.False(await runtime.Report("screen",report with {PageSessionId=Json.Id()})); Assert.False(await runtime.Report("screen",report with {State=report.State with {PlaybackGeneration=0}})); Assert.False(await runtime.Report("screen",report with {State=report.State with {SourceFingerprint="wrong"}}));
        Assert.True(await runtime.Report("screen",report)); Assert.False(await runtime.Report("screen",report)); Assert.Equal("applied",(await runtime.Dispatch(command,"admin")).Status);
        var paused = new CommandEnvelope(Json.Id(),"visual","pause",JsonSerializer.SerializeToElement(new {}),state.Revision,state.Desired.Visual.PlaybackGeneration); await runtime.Dispatch(paused,"admin"); var pausedState = await runtime.Snapshot();
        Assert.True(await runtime.Report("screen",report with { Sequence=2,State=report.State with {LastAppliedRevision=pausedState.Revision} })); Assert.Equal("accepted",(await runtime.Dispatch(paused,"admin")).Status);
        Assert.True(await runtime.Report("screen",report with {Sequence=3,State=report.State with {Status="paused",LastAppliedRevision=pausedState.Revision}})); Assert.Equal("applied",(await runtime.Dispatch(paused,"admin")).Status);
    }
    [Fact] public async Task EndedPausesDesiredAndStaleEndedCannotAffectNewSource()
    {
        using var app = new TestApp(); using var client = await app.Admin(); var runtime=app.Services.GetRequiredService<Runtime>(); var sessions=app.Services.GetRequiredService<ScreenSessions>(); var page=Json.Id(); sessions.Register("s",new("primary",page,new(1280,720)));
        var before=await runtime.Snapshot(); await runtime.Dispatch(new(Json.Id(),"visual","setSource",JsonSerializer.SerializeToElement(new {source=(VisualSource)new YouTubeVideo("dQw4w9WgXcQ"),autoplay=true},Json.Options),before.Revision,0),"admin");
        var selected=await runtime.Snapshot(); var ended=new PlaybackReport(page,selected.ServerInstanceId,"visual",1,new() {Status="ended",SourceFingerprint=Validate.Fingerprint(selected.Desired.Visual.Source),PlaybackGeneration=1,LastAppliedRevision=selected.Revision,PositionSeconds=120,DurationSeconds=120});
        Assert.True(await runtime.Report("s",ended)); var after=await runtime.Snapshot(); Assert.Equal("paused",after.Desired.Visual.Transport); Assert.True(after.Checkpoints.Visual!.Ended);
        await runtime.Dispatch(new(Json.Id(),"visual","play",JsonSerializer.SerializeToElement(new {}),after.Revision,1),"admin"); Assert.False(await runtime.Report("s",ended with {Sequence=2})); Assert.Equal("playing",(await runtime.Snapshot()).Desired.Visual.Transport);
    }
    [Fact] public async Task DurableDeletionIntentHidesAssetAndStartupFinishesDeletion()
    {
        using var app=new TestApp(); var id=Json.Id(); var asset=new Asset(id,"video",id+".mp4","video/mp4",12,"hash",DateTimeOffset.UtcNow);
        await File.WriteAllBytesAsync(app.Data.Paths.Get("media/videos/"+asset.FileName),new byte[12]);
        await app.Data.Store.Update<CollectionDocument<Asset>>("library/video-library.json",d=>{d.Items.Add(asset);return d;});
        await app.Data.Store.Update<DeletionDocument>("trash/deletions.json",d=>{d.Items.Add(new("videos",id,asset.FileName));return d;});
        using var client=await app.Admin(); Assert.Empty((await client.GetFromJsonAsync<CollectionDocument<Asset>>("/api/library/videos",Json.Options))!.Items); Assert.False(File.Exists(app.Data.Paths.Get("media/videos/"+asset.FileName))); Assert.Empty((await app.Data.Store.Read<DeletionDocument>("trash/deletions.json")).Items);
    }
    [Fact] public async Task StorageFailureNeverReportsSaved()
    {
        using var app=new TestApp(); using var client=await app.Admin(); var runtime=app.Services.GetRequiredService<Runtime>(); var state=await runtime.Snapshot();
        Directory.CreateDirectory(app.Data.Paths.Get("settings/runtime-state.json"));
        await runtime.Dispatch(new(Json.Id(),"visual","setTransform",JsonSerializer.SerializeToElement(new Transform(100,20),Json.Options),state.Revision,0),"admin"); Assert.Equal("failed",(await runtime.Snapshot()).Persistence); Assert.Equal(100,(await runtime.Snapshot()).Desired.Visual.Transform.X);
        Directory.Delete(app.Data.Paths.Get("settings/runtime-state.json")); await runtime.Flush(); Assert.Equal("saved",(await runtime.Snapshot()).Persistence);
    }
    private static async Task<(string Visual,string Audio)> Seed(TestApp app)
    {
        var v=Json.Id(); var a=Json.Id(); var now=DateTimeOffset.UtcNow;
        await app.Data.Store.Update<CollectionDocument<VisualPreset>>("presets/visual-presets.json",d=>{ d.Items.Add(new(v,"Video",new YouTubeVideo("dQw4w9WgXcQ"),true,new(),new(),0,null,now,now));return d; });
        await app.Data.Store.Update<CollectionDocument<AudioPreset>>("presets/audio-presets.json",d=>{ d.Items.Add(new(a,"Audio",new RemoteAudioUrl("https://radio.example/stream","live"),new(),0,now,now));return d; });return(v,a);
    }
}
