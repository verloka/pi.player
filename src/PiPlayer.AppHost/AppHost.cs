// Windows debug orchestration: one F5 starts the .NET backend and the Angular dev server together,
// with logs, traces and both pages linked from the Aspire dashboard. The Raspberry Pi release does
// not use Aspire at all: there the published backend serves the compiled Angular bundle by itself.
var builder = DistributedApplication.CreateBuilder(args);

var dataPath = Environment.GetEnvironmentVariable("PiPlayer__DataPath");
if (string.IsNullOrWhiteSpace(dataPath))
    dataPath = Path.Combine(builder.AppHostDirectory, "..", "..", "artifacts", "dev-data");
dataPath = Path.GetFullPath(dataPath);
Directory.CreateDirectory(dataPath);

var backend = builder.AddProject<Projects.PiPlayer_Server>("backend", launchProfileName: null)
    .WithHttpEndpoint(port: 5000, targetPort: 5000, name: "http", isProxied: false)
    .WithEnvironment("ASPNETCORE_ENVIRONMENT", "Development")
    .WithEnvironment("PiPlayer__DataPath", dataPath)
    .WithHttpHealthCheck("/api/system/ready")
    .WithUrl("http://localhost:5000/api/system/diagnostics", "Diagnostics");

builder.AddJavaScriptApp("frontend", "../PiPlayer.Web")
    .WithNpm(installCommand: "ci")
    .WithRunScript("start")
    .WithHttpEndpoint(port: 4200, targetPort: 4200, name: "http", isProxied: false)
    .WithHttpHealthCheck("/admin", endpointName: "http")
    .WithUrl("http://localhost:4200/admin", "Control panel")
    .WithUrl("http://localhost:4200/screen", "Screen")
    .WaitFor(backend);

builder.Build().Run();
