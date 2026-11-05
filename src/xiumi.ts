import type { Page } from "playwright-core";
import { STUDIO_NEW } from "./config.ts";

const TPL_API = "https://xiumi.us/api/templates";

export type XiumiStatus = {
  url: string;
  loggedIn: boolean;
  articleId: string | null;
  title: string;
  comps: number;
  textCells: number;
  preview: string;
};

/** Xiumi sometimes blocks the editor with a "recover unsaved draft?" dialog. Dismiss it. */
async function dismissRecoveryDialog(page: Page): Promise<boolean> {
  const clicked = await page
    .evaluate(() => {
      const text = document.body ? document.body.innerText.slice(0, 800) : "";
      if (!/是否恢复|没有保存到服务器/.test(text)) return false;
      const btn = [...document.querySelectorAll("button, a, .btn, span, div")].find(
        (el) =>
          el.children.length === 0 &&
          /^取消$/.test((el.textContent || "").trim()) &&
          el.getBoundingClientRect().height > 0,
      );
      if (!btn) return false;
      (btn as HTMLElement).click();
      return true;
    })
    .catch(() => false);
  if (clicked) await page.waitForTimeout(600);
  return clicked;
}

export async function ensureStudio(page: Page): Promise<void> {
  if (!page.url().includes("xiumi.us/studio/v5")) {
    await page.goto(STUDIO_NEW, { waitUntil: "domcontentloaded", timeout: 90_000 });
  }

  for (let i = 0; i < 30; i++) {
    if (await dismissRecoveryDialog(page)) continue;
    if ((await page.locator(".tn-page-inst").count()) > 0) break;
    await page.waitForTimeout(500);
  }

  await page.waitForSelector(".tn-page-inst", { timeout: 60_000 });
  await page
    .waitForFunction(
      () => {
        const tabs = [...document.querySelectorAll(".x3-tab-item")];
        const ready = tabs.some((tab) => {
          const scope = window.angular ? window.angular.element(tab).scope() : null;
          return Boolean(scope && scope.tplLib);
        });
        return ready && Boolean(document.querySelector(".tn-page-inst .tn-cell-text, .tn-page-inst .tn-page"));
      },
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(400);
}

export async function getStatus(page: Page): Promise<XiumiStatus> {
  return page.evaluate(() => {
    const isXiumi = location.hostname.endsWith("xiumi.us");
    const studioRoot = document.querySelector(".tn-studio-root");
    const paper = document.querySelector(".tn-page-inst") as HTMLElement | null;
    const titleInput = document.querySelector(".tn-meta-panel input") as HTMLInputElement | null;
    const signIn = document.querySelector(".usr-sign-in");
    const loggedIn =
      isXiumi &&
      !!studioRoot &&
      (!!document.querySelector(".user-level") || (!!signIn && (signIn.textContent || "").trim() !== "登录"));
    const m = location.hash.match(/\/paper\/(?:for\/)?(\d+)/);
    return {
      url: location.href,
      loggedIn,
      articleId: m ? m[1] : null,
      title: titleInput ? titleInput.value : "",
      comps: document.querySelectorAll(".tn-page-inst .tn-comp-top-level").length,
      textCells: document.querySelectorAll(".tn-page-inst .tn-cell-text").length,
      preview: (paper ? paper.innerText : "").replace(/\s+/g, " ").trim().slice(0, 300),
    };
  });
}

/** Open the login screen in its own tab. The user completes it manually (QR code or password). */
export async function openLogin(
  page: Page,
): Promise<{ ok: boolean; url: string; alreadyLoggedIn: boolean; loginPage?: Page }> {
  const status = await getStatus(page);
  if (status.loggedIn) return { ok: true, url: page.url(), alreadyLoggedIn: true };

  const existing = page
    .context()
    .pages()
    .find((p) => p.url().includes("xiumi.us/auth"));
  if (existing) {
    await existing.bringToFront().catch(() => {});
    return { ok: true, url: existing.url(), alreadyLoggedIn: false, loginPage: existing };
  }

  const loginPage = await page.context().newPage();
  await loginPage.goto(
    "https://xiumi.us/auth?callback_url=https%3A%2F%2Fxiumi.us%2Fauth%2Freport%2Fresult%2Fsuccess&failed_callback_url=https%3A%2F%2Fxiumi.us%2Fauth%2Freport%2Fresult%2Ffailed&delay_time=200#/",
    { waitUntil: "domcontentloaded", timeout: 60_000 },
  );
  await loginPage.waitForTimeout(1500);
  await loginPage.bringToFront().catch(() => {});
  return {
    ok: loginPage.url().includes("/auth"),
    url: loginPage.url(),
    alreadyLoggedIn: false,
    loginPage,
  };
}

export async function waitForLogin(loginPage: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (loginPage.isClosed()) return true;
    if (!loginPage.url().includes("/auth")) return true;
    const formGone = await loginPage
      .evaluate(() => !document.querySelector(".login-button, .usr-sign-in, input[placeholder*='密码']"))
      .catch(() => false);
    if (formGone) return true;
    await loginPage.waitForTimeout(1500);
  }
  return false;
}

export async function listTemplateTags(page: Page): Promise<Array<{ id: number; name: string; children: Array<{ id: number; name: string }> }>> {
  return page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".x3-tab-item")];
    const scope = tabs
      .map((tab) => (window.angular ? window.angular.element(tab).scope() : null))
      .find((s) => s && s.tplLib);
    const list = (scope && scope.tplLib && scope.tplLib.tagLv1List) || [];
    return list.map((t) => ({
      id: t.tag_id,
      name: t.tag_name,
      children: (t.childTags || []).map((c) => ({ id: c.tag_id, name: c.tag_name })),
    }));
  });
}

export type TemplateInfo = {
  id: number;
  tags: string[];
  text: string;
  html: string;
  raw: Record<string, unknown>;
};

export async function searchTemplates(
  page: Page,
  opts: { query?: string; tagIds?: number[]; limit?: number; pageNo?: number },
): Promise<{ total: number; items: TemplateInfo[]; error?: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 30);
  const pageNo = Math.max(opts.pageNo ?? 0, 0);
  const data = await page.evaluate(
    async ({ q, tagIds, limit, pageNo, api }) => {
      const params = new URLSearchParams({
        tag_category: "paper-cp",
        template_category: "paper-cp",
        match_level: "default",
        sort: "DESC",
        limit: String(limit),
        page: String(pageNo),
        q: q || "",
      });
      if (tagIds && tagIds.length) params.set("tag_ids", tagIds.join(","));
      const res = await fetch(api + "?" + params, { credentials: "include" });
      const json = await res.json();
      if (!json || json.code !== 0) {
        return { total: 0, items: [], error: json && json.message };
      }
      const items = (json.data.templates || []).map((t) => ({
        id: t.template_id,
        tags: (t.tags || []).map((x) => x.tag_name).filter(Boolean),
        html: t.renderer_accelerate || "",
        raw: t,
      }));
      return { total: json.data.count || 0, items };
    },
    { q: opts.query ?? "", tagIds: opts.tagIds ?? [], limit, pageNo, api: TPL_API },
  );

  if (data.error) {
    if (data.error === "Auth:Failed_NotLogin") {
      return {
        total: 0,
        items: [],
        error: "关键词搜索需要登录秀米。请先 xiumi_login 扫码登录；未登录时只能用 tagIds 浏览分类。",
      };
    }
    return { total: 0, items: [], error: `模板接口返回错误：${data.error}` };
  }

  const items = data.items.map((t: { id: number; tags: string[]; html: string; raw: Record<string, unknown> }) => ({
    id: t.id,
    tags: t.tags,
    html: t.html,
    raw: t.raw,
    text: t.html
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120),
  }));
  return { total: data.total, items };
}

export async function getTopLevelComps(page: Page): Promise<Array<{ id: string; text: string; slots: number; images: number }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".tn-page-inst .tn-comp-top-level")].map((el) => {
      const cells = [...el.querySelectorAll<HTMLElement>(".tn-cell-text")].filter((c) => {
        const style = getComputedStyle(c);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      return {
        id: el.getAttribute("tn-uuid") || "",
        text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
        slots: cells.length,
        images: el.querySelectorAll(".tn-cell-image").length,
      };
    }),
  );
}

export async function listImageCells(
  page: Page,
  compId?: string,
): Promise<Array<{ index: number; src: string; width: number; height: number }>> {
  return page.evaluate((id) => {
    const root = id ? document.querySelector(`.tn-page-inst [tn-uuid="${id}"]`) : document.querySelector(".tn-page-inst");
    if (!root) return [];
    return [...root.querySelectorAll(".tn-cell-image")].map((cell, index) => {
      const img = cell.querySelector("img");
      const r = cell.getBoundingClientRect();
      return {
        index,
        src: img ? img.getAttribute("src") || "" : "",
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });
  }, compId ?? "");
}

/** Upload image bytes to the Xiumi asset store and return the hosted URL. */
export async function uploadImage(
  page: Page,
  base64: string,
  fileName: string,
  mime: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  return page.evaluate(
    async ({ b64, name, type }) => {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const fd = new FormData();
        fd.append("updateTsIfExisted", "true");
        fd.append("image_file", new Blob([bytes], { type }), name);
        const res = await fetch("/api/assets/image/file", { method: "POST", body: fd, credentials: "include" });
        const json = await res.json();
        const uri = json && json.data && json.data.target_uri;
        if (!uri) return { ok: false, error: (json && json.message) || `上传失败（HTTP ${res.status}）` };
        return { ok: true, url: uri.startsWith("//") ? "https:" + uri : uri };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    { b64: base64, name: fileName, type: mime },
  );
}

export async function setImage(
  page: Page,
  compId: string,
  slotIndex: number,
  url: string,
): Promise<{ ok: boolean; src?: string; error?: string }> {
  return page.evaluate(
    ({ id, idx, src }) => {
      const root = document.querySelector(`.tn-page-inst [tn-uuid="${id}"]`);
      if (!root) return { ok: false, error: `找不到组件 ${id}` };
      const cells = [...root.querySelectorAll(".tn-cell-image")];
      const cell = cells[idx];
      if (!cell) return { ok: false, error: `组件只有 ${cells.length} 个图片槽，索引 ${idx} 超出范围` };
      const scope = window.angular.element(cell).scope();
      if (!scope || !scope.cell) return { ok: false, error: "无法访问该图片槽的模型" };
      scope.cell.src = src;
      try {
        scope.$apply();
      } catch {
        scope.$evalAsync(() => {});
      }
      const img = cell.querySelector("img");
      return { ok: true, src: img ? img.getAttribute("src") || "" : src };
    },
    { id: compId, idx: slotIndex, src: url },
  );
}

export type TypographyOptions = {
  /** body = only paragraphs longer than minChars; all = every text slot. */
  scope?: "body" | "all";
  minChars?: number;
  fontSizePercent?: number;
  lineHeight?: number;
  letterSpacingPx?: number;
  color?: string;
};

/** Adjust font size / line height / letter spacing on text cells. */
export async function setTypography(
  page: Page,
  opts: TypographyOptions,
): Promise<{ ok: boolean; changed: number; error?: string }> {
  return page.evaluate(
    ({ scope, minChars, fs, lh, ls, color }) => {
      const cells = [...document.querySelectorAll<HTMLElement>(".tn-page-inst .tn-cell-text")];
      let changed = 0;
      let rootScope: any = null;
      for (const cell of cells) {
        const text = (cell.innerText || "").trim();
        if (!text) continue;
        if (scope === "body" && text.length < minChars) continue;
        const scopeObj = window.angular.element(cell).scope();
        const style = scopeObj && scopeObj.cell && scopeObj.cell.style;
        if (!style) continue;
        if (fs) style.fontSize = `${fs.toFixed(4)}%`;
        if (lh) style.lineHeight = String(lh);
        if (ls !== null && ls !== undefined) style.letterSpacing = `${ls}px`;
        if (color) style.color = color;
        changed++;
        rootScope = rootScope || scopeObj;
      }
      if (!rootScope) return { ok: false, changed: 0, error: "没有可调整的文本槽" };
      try {
        rootScope.$apply();
      } catch {
        rootScope.$evalAsync(() => {});
      }
      return { ok: true, changed };
    },
    {
      scope: opts.scope ?? "body",
      minChars: opts.minChars ?? 25,
      fs: opts.fontSizePercent,
      lh: opts.lineHeight,
      ls: opts.letterSpacingPx,
      color: opts.color,
    },
  );
}

/** Delete one top-level component. Returns false when the component cannot be found. */
export async function deleteComp(page: Page, compId: string): Promise<{ ok: boolean; error?: string }> {
  const rect = await page.evaluate((id) => {
    const el = document.querySelector(`.tn-page-inst [tn-uuid="${id}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  }, compId);
  if (!rect) return { ok: false, error: `找不到组件 ${compId}` };

  const [x, y, w, h] = rect;
  const points = [
    [x + 10, y + 8],
    [x + w - 12, y + 8],
    [x + w / 2, y + 6],
    [x + 10, y + h / 2],
  ];

  let clicked = false;
  for (const [px, py] of points) {
    await page.mouse.click(px, py);
    await page.waitForTimeout(450);
    const btn = await page.evaluate(() => {
      const b = document.querySelector(".op-dc-bar-cp-attr .dc-cp-delete button");
      return b ? b.getBoundingClientRect().toJSON() : null;
    });
    if (!btn) continue;
    await page.mouse.click(btn.x + btn.width / 2, btn.y + btn.height / 2);
    clicked = true;
    break;
  }
  if (!clicked) return { ok: false, error: "选中组件后没有出现删除按钮" };
  await page.waitForTimeout(500);

  const confirmRect = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("[class*='modal'] button, [class*='dialog'] button")]
      .find((b) => /确定|删除|确认/.test((b.textContent || "").trim()));
    return btn ? btn.getBoundingClientRect().toJSON() : null;
  });
  if (confirmRect) {
    await page.mouse.click(confirmRect.x + confirmRect.width / 2, confirmRect.y + confirmRect.height / 2);
  }
  await page.waitForTimeout(700);
  const still = await page.evaluate((id) => !!document.querySelector(`.tn-page-inst [tn-uuid="${id}"]`), compId);
  return still ? { ok: false, error: "删除后组件仍然存在" } : { ok: true };
}

/** Clear the current component selection so the next insertion appends at the end. */
export async function deselect(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

export async function insertTemplate(
  page: Page,
  tpl: { template_id: number; [k: string]: unknown },
  opts: { at?: "end" | "cursor" } = {},
): Promise<{
  ok: boolean;
  compId: string | null;
  comps: Array<{ id: string; slots: Array<{ text: string; visible: boolean }>; images: number }>;
  error?: string;
}> {
  if ((opts.at ?? "end") === "end") await deselect(page);

  const before = await page.evaluate(() =>
    [...document.querySelectorAll(".tn-page-inst [tn-uuid]")].map((el) => el.getAttribute("tn-uuid")),
  );

  const result = await page.evaluate((template) => {
    const tabs = [...document.querySelectorAll(".x3-tab-item")];
    const scope = tabs
      .map((tab) => (window.angular ? window.angular.element(tab).scope() : null))
      .find((s) => s && s.tplLib && typeof s.tplLib.onTemplateClicked === "function");
    if (!scope) {
      return { ok: false, error: "模板库尚未加载，请先调用 xiumi_start 并等待编辑器就绪" };
    }
    const noop = () => {};
    const ev = {
      isDefaultPrevented: () => false,
      isImmediatePropagationStopped: () => false,
      isPropagationStopped: () => false,
      preventDefault: noop,
      stopPropagation: noop,
      stopImmediatePropagation: noop,
      type: "click",
      which: 1,
      button: 0,
      target: document.body,
      currentTarget: document.body,
      originalEvent: null,
    };
    try {
      scope.tplLib.onTemplateClicked(ev, template);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, tpl);

  if (!result.ok) return { ok: false, compId: null, comps: [], error: result.error };
  await page.waitForTimeout(900);

  const roots = await page.evaluate((beforeIds) => {
    const all = [...document.querySelectorAll(".tn-page-inst [tn-uuid]")];
    const fresh = all.filter((el) => !beforeIds.includes(el.getAttribute("tn-uuid")));
    const top = fresh.filter((el) => !fresh.some((other) => other !== el && other.contains(el)));
    return top.map((el) => {
      const cells = [...el.querySelectorAll<HTMLElement>(".tn-cell-text")];
      return {
        id: el.getAttribute("tn-uuid") || "",
        slots: cells.map((c) => {
          const style = getComputedStyle(c);
          return {
            text: (c.innerText || "").trim().slice(0, 30),
            visible: style.display !== "none" && style.visibility !== "hidden",
          };
        }),
        images: el.querySelectorAll(".tn-cell-image").length,
      };
    });
  }, before);

  if (!roots.length) {
    return { ok: false, compId: null, comps: [], error: "插入未生效：编辑器可能还没完全就绪，请重试或先调用 xiumi_status" };
  }
  return { ok: true, compId: roots[0].id, comps: roots };
}

export async function fillText(
  page: Page,
  compId: string,
  slotIndex: number,
  text: string,
): Promise<{ ok: boolean; error?: string; value?: string }> {
  return page.evaluate(
    ({ id, idx, value }) => {
      const root = document.querySelector(`.tn-page-inst [tn-uuid="${id}"]`);
      if (!root) return { ok: false, error: `找不到组件 ${id}` };
      const cells = [...root.querySelectorAll<HTMLElement>(".tn-cell-text")].filter((c) => {
        const style = getComputedStyle(c);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      const cell = cells[idx];
      if (!cell) return { ok: false, error: `组件只有 ${cells.length} 个可见文本槽，索引 ${idx} 超出范围` };
      const scope = window.angular.element(cell).scope();
      const model = scope && (scope.cell || scope.comp);
      if (!model || typeof model.text !== "string") return { ok: false, error: "无法访问该文本槽的模型" };
      const esc = (s) =>
        String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      model.text = String(value)
        .split("\n")
        .map((line) => `<p>${esc(line)}</p>`)
        .join("");
      try {
        scope.$apply();
      } catch {
        scope.$evalAsync(() => {});
      }
      return { ok: true, value: (cell.innerText || "").trim() };
    },
    { id: compId, idx: slotIndex, value: text },
  );
}

export async function setTitle(page: Page, title: string): Promise<string> {
  const input = page.locator(".tn-meta-panel input").first();
  await input.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(title, { delay: 8 });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  return input.inputValue();
}

export async function setSummary(page: Page, summary: string): Promise<string> {
  const textarea = page.locator(".tn-meta-panel textarea").first();
  if ((await textarea.count()) === 0) return "";
  await textarea.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(summary, { delay: 8 });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  return textarea.inputValue();
}

/** Trigger 导出 → 继续用复制粘贴 and read the final WeChat-ready HTML from the clipboard. */
export async function exportHtml(page: Page): Promise<{ ok: boolean; html: string; error?: string }> {
  await page.bringToFront().catch(() => {});
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>("header button")].find((b) => b.innerText.trim() === "导出");
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) return { ok: false, html: "", error: "未找到「导出」按钮" };
  await page.waitForTimeout(500);

  const clicked = await page.evaluate(() => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>("header a")].find((a) => a.innerText.trim() === "继续用复制粘贴");
    if (!link) return false;
    link.click();
    return true;
  });
  if (!clicked) return { ok: false, html: "", error: "未找到「继续用复制粘贴」入口" };

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(600);
    const html = await page.evaluate(async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/html")) {
            const blob = await item.getType("text/html");
            return await blob.text();
          }
        }
      } catch {
        return "";
      }
      return "";
    });
    if (html && html.includes("<section")) return { ok: true, html };
  }
  return { ok: false, html: "", error: "剪贴板里没有拿到 HTML（请确认浏览器窗口处于焦点状态）" };
}

/** Save to the Xiumi account. Requires login. */
export async function saveArticle(page: Page): Promise<{ ok: boolean; message: string; url: string }> {
  const before = await page.evaluate(() => document.body.innerText);
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>("header button")].find((b) => b.innerText.trim() === "保存");
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) return { ok: false, message: "未找到「保存」按钮", url: page.url() };
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => document.body.innerText);
  const toast = after
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .find((line) => /保存|登录|失败|错误/.test(line) && !before.includes(line));
  if (/登录以后才可以保存/.test(after)) {
    return { ok: false, message: "需要先登录秀米（调用 xiumi_login）", url: page.url() };
  }
  return { ok: true, message: toast ?? "已触发保存", url: page.url() };
}

export async function screenshotPaper(page: Page): Promise<Buffer> {
  await deselect(page);
  const style = await page
    .addStyleTag({
      content:
        ".tn-header,.left-sidebar,.tn-meta-panel,.op-dock-bar,.tn-page-toolbar,.tn-quick-input-block{display:none!important}",
    })
    .catch(() => null);
  try {
    for (const selector of [".tn-page-container", ".tn-page-inst"]) {
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) continue;
      const box = await loc.boundingBox();
      if (!box || box.height < 20) continue;
      const shot = await loc.screenshot({ timeout: 30_000, animations: "disabled" }).catch(() => null);
      if (shot) return shot;
    }
    return page.screenshot({});
  } finally {
    await style?.evaluate((el) => el.remove()).catch(() => {});
  }
}
