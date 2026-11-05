import { homedir } from "node:os";
import { join } from "node:path";

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}

/** Persistent browser profile so the Xiumi login survives restarts. */
export const PROFILE_DIR =
  process.env.XIUMI_PROFILE_DIR ?? join(localAppData(), "xiumi-mcp", "profile");

/** Port for the DevTools endpoint of the dedicated browser instance. */
export const CDP_PORT = Number(process.env.XIUMI_CDP_PORT ?? 9333);

/** Connect to an already running browser instead of launching one. */
export const CDP_URL = process.env.XIUMI_CDP_URL ?? `http://127.0.0.1:${CDP_PORT}`;

export const STUDIO_NEW = "https://xiumi.us/studio/v5#/paper/for/new/cube/0";

export const HEADLESS = process.env.XIUMI_HEADLESS === "1";

/** Keep the browser window visible by default: login and previews are manual steps. */
export const KEEP_BROWSER_OPEN = process.env.XIUMI_KEEP_BROWSER !== "0";
