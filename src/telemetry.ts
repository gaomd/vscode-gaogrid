import { TelemetryReporter } from "@vscode/extension-telemetry";
import * as vscode from "vscode";

/** Reports one extension-level usage event through VS Code's telemetry logger. */
export class GaoGridTelemetry {
  private readonly reporter?: TelemetryReporter;

  constructor(enabled: boolean) {
    const connectionString = process.env.TELEMETRY_CONNECTION_STRING?.trim();
    if (!enabled || !connectionString) return;
    try {
      this.reporter = new TelemetryReporter(
        connectionString,
        undefined,
        undefined,
        undefined,
        {
          commonProperties: {
            appName: vscode.env.appName || "unknown",
            appHost: vscode.env.appHost || "unknown",
            uriScheme: vscode.env.uriScheme || "unknown",
          },
          tagOverrides: { "ai.cloud.role": "gaomd.gaogrid" },
        },
      );
    } catch {
      // Telemetry must never prevent the extension from starting.
    }
  }

  recordUsage() {
    this.reporter?.sendTelemetryEvent("extension_usage");
  }

  dispose() {
    void this.reporter?.dispose();
  }
}
