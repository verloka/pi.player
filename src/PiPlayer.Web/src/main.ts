import { Component, provideZonelessChangeDetection } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, RouterOutlet } from "@angular/router";
@Component({
  selector: "app-root",
  imports: [RouterOutlet],
  template: "<router-outlet />",
})
class App {}
bootstrapApplication(App, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter([
      {
        path: "admin",
        loadComponent: () =>
          import("./app/admin/admin.component").then((m) => m.AdminComponent),
      },
      {
        path: "screen",
        loadComponent: () =>
          import("./app/screen/screen.component").then(
            (m) => m.ScreenComponent,
          ),
      },
      { path: "", pathMatch: "full", redirectTo: "admin" },
      { path: "**", redirectTo: "admin" },
    ]),
  ],
}).catch(console.error);
