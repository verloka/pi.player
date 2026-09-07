namespace PiPlayer.Server.Configuration;
public class PiPlayerOptions
{
    public string DataPath { get; set; } = "data";
    public long MaxVideoUploadBytes { get; set; } = 524288000;
    public long MaxAudioUploadBytes { get; set; } = 104857600;
    public long MinFreeDiskBytes { get; set; } = 1073741824;
    public int MaxConcurrentUploads { get; set; } = 1;
    public double MaxEffectiveDimension { get; set; } = 4096;
    public double MaxRenderedArea { get; set; } = 8294400;
    // Rotating the embedded YouTube player is enabled by design here. It remains a switch because it is
    // a modification of the provider's surface: turn it off if a deployment must stay conservative.
    public bool EnableExperimentalYouTubeRotation { get; set; } = true;
    // Dashed alignment ring on the control panel's schematic. 0 hides it.
    public double GuideCircleDiameterMillimetres { get; set; } = 225;
    // Measured width of the physical panel. 0 means unknown: the schematic then assumes 96 dpi, which
    // is only right if the display really has that density.
    public double ScreenWidthMillimetres { get; set; }
    public string[] RemoteAudioAllowedHosts { get; set; } = [];
    // Left empty on purpose: the configuration binder appends to a non-empty array, which would
    // duplicate the schedule whenever appsettings.json also lists it. Defaults are applied below.
    public int[] RemoteRetrySeconds { get; set; } = [];
    public int RemoteRetryBudgetSeconds { get; set; } = 120;
    public PiPlayerOptions Normalized()
    {
        if (RemoteRetrySeconds.Length == 0) RemoteRetrySeconds = [1, 2, 5, 10, 30];
        return this;
    }
}
