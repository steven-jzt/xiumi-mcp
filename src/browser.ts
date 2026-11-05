import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { CDP_PORT, CDP_URL, HEADLESS, PROFILE_DIR } from "./config.ts";

const BROWSER_CANDIDATES = [
  process.env.XIUMI_BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((p): p is string => Boolean(p));

export function findBrowserExecutable(): string {
  for (const p of BROWSER_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "未找到 Edge 或 Chrome。请安装其中之一，或设置环境变量 XIUMI_BROWSER_PATH 指向浏览器可执行文件。",
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let launching: Promise<void> | null = null;

async function launchBrowser(): Promise<void> {
  if (await cdpAlive()) return;
  if (launching) return launching;

  launching = (async () => {
    const bin = findBrowserExecutable();
    mkdirSync(PROFILE_DIR, { recursive: true });
    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=msEdgeSidebarV2,msEdgeIdentityFeature,msEdgeFirstRunExperience",
      "--disable-crash-reporter",
      HEADLESS ? "--headless=new" : "--start-maximized",
      "about:blank",
    ];
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.unref();

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await cdpAlive()) return;
      await sleep(400);
    }
    throw new Error(
      "浏览器启动超时：DevTools 端口未就绪。若有残留的 xiumi-mcp 浏览器窗口，请先全部关闭后重试。",
    );
  })();

  try {
    await launching;
  } finally {
    launching = null;
  }
}

export type Session = {
  browser: Browser;
  context: BrowserContext;
};

let session: Session | null = null;

export async function getSession(): Promise<Session> {
  if (session?.browser.isConnected()) return session;
  await launchBrowser();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  await context
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "https://xiumi.us",
    })
    .catch(() => {});
  session = { browser, context };
  return session;
}

let editorPage: Page | null = null;

/** Find the Xiumi studio tab, creating one if needed. Login runs in a separate tab. */
export async function getStudioPage(): Promise<Page> {
  const { context } = await getSession();
  if (editorPage && !editorPage.isClosed()) return editorPage;
  const pages = context.pages();
  const studioPages = pages.filter((p) => p.url().includes("xiumi.us/studio/v5"));
  const existing =
    studioPages.find((p) => /\/paper\/for\/\d+/.test(p.url())) ??
    studioPages[0] ??
    pages.find((p) => p.url().includes("xiumi.us") && !p.url().includes("/auth"));
  editorPage = existing ?? (await context.newPage());
  return editorPage;
}

export async function closeBrowser(): Promise<void> {
  if (!session) return;
  await session.browser.close().catch(() => {});
  session = null;
}
