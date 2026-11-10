// Starts, watches and stops a test copy of AffinityGeo.
import type { ElectronApplication, Page } from "playwright-core";

export interface LaunchOptions { build: boolean; fixtures: boolean }

export interface AppDriver {
  launch(opts: LaunchOptions): Promise<void>;
  quit(): Promise<void>;
  running(): boolean;
  /** Throws a ToolError when the app isn't running. */
  page(): Page;
  /** Throws a ToolError when the app isn't running. */
  electron(): ElectronApplication;
  logs(lines: number): Promise<{ mainLog: string[]; consoleErrors: string[] }>;
}
