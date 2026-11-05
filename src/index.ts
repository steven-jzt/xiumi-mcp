#!/usr/bin/env node
import { writeFile, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getStudioPage } from "./browser.ts";
import {
  ensureStudio,
  exportHtml,
  fillText,
  getStatus,
  getTopLevelComps,
  insertTemplate,
  listTemplateTags,
  openLogin,
  saveArticle,
  screenshotPaper,
  searchTemplates,
  setSummary,
  setTitle,
  waitForLogin,
  deleteComp,
  listImageCells,
  setImage,
  uploadImage,
  setTypography,
} from "./xiumi.ts";

const server = new McpServer(
  { name: "xiumi-mcp", version: "0.1.0" },
  {
    instructions:
      "秀米（XIUMI）公众号图文排版工具。典型流程：xiumi_start → xiumi_search_templates 选模板 → xiumi_insert_template → xiumi_fill_text 填字 / xiumi_set_image 换图 → xiumi_set_meta 设标题/摘要 → xiumi_screenshot 检查 → xiumi_get_html 取最终 HTML（或 xiumi_save 存到秀米）。保存和同步需要先 xiumi_login 扫码登录。",
  },
);

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function guarded<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  return async (...args: A) => {
    try {
      return await serial(() => fn(...args));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return fail(message);
    }
  };
}

/** Last search results, so insert-by-id does not need a second lookup endpoint. */
const templateCache = new Map<number, Record<string, unknown>>();

server.registerTool(
  "xiumi_start",
  {
    title: "启动秀米编辑器",
    description:
      "启动专用浏览器（持久化登录态）并打开秀米图文编辑器，返回登录状态与当前文章信息。首次使用、浏览器被关闭或需要新开空白图文时调用。",
    inputSchema: {
      fresh: z.boolean().optional().describe("true 时新开一篇空白图文；默认复用当前已打开的编辑器"),
    },
  },
  guarded(async ({ fresh }: { fresh?: boolean }) => {
    const page = await getStudioPage();
    if (fresh) {
      await page.goto("about:blank");
      await page.goto("https://xiumi.us/studio/v5#/paper/for/new/cube/0", {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
    }
    await ensureStudio(page);
    await page.bringToFront().catch(() => {});
    return json(await getStatus(page));
  }),
);

server.registerTool(
  "xiumi_open_article",
  {
    title: "打开已有图文",
    description: "按文章 ID 打开已保存的秀米图文（ID 来自 xiumi_save 返回的 URL 或 xiumi_status）。",
    inputSchema: {
      articleId: z.string().describe("秀米图文 ID，例如 736653640"),
    },
  },
  guarded(async ({ articleId }: { articleId: string }) => {
    const page = await getStudioPage();
    await page.goto(`https://xiumi.us/studio/v5#/paper/for/${articleId}/cube/0`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
    await ensureStudio(page);
    return json(await getStatus(page));
  }),
);

server.registerTool(
  "xiumi_status",
  {
    title: "读取编辑器状态",
    description: "读取当前秀米编辑器状态：是否登录、文章 ID、标题、组件数、文本槽数量与正文预览。",
    inputSchema: {},
  },
  guarded(async () => {
    const page = await getStudioPage();
    await ensureStudio(page);
    return json(await getStatus(page));
  }),
);

server.registerTool(
  "xiumi_login",
  {
    title: "登录秀米",
    description:
      "打开秀米登录页并返回截图。请在弹出的浏览器窗口里用微信扫码或账号密码完成登录；等待 waitSeconds 秒后返回是否登录成功。",
    inputSchema: {
      waitSeconds: z.number().int().min(0).max(300).optional().describe("登录后最多等待多少秒，默认 0 表示立即返回"),
    },
  },
  guarded(async ({ waitSeconds }: { waitSeconds?: number }) => {
    const page = await getStudioPage();
    await ensureStudio(page);
    const opened = await openLogin(page);
    const loginPage = opened.loginPage ?? page;
    let loggedIn = opened.alreadyLoggedIn;
    if (!loggedIn && waitSeconds && waitSeconds > 0) {
      loggedIn = await waitForLogin(loginPage, waitSeconds * 1000);
      if (loggedIn) {
        await loginPage.close().catch(() => {});
        await page.goto("https://xiumi.us/studio/v5#/paper/for/new/cube/0", { waitUntil: "domcontentloaded" });
        await ensureStudio(page);
      }
    }
    const shotPage = loggedIn ? page : loginPage;
    const png = await shotPage.screenshot({ type: "png", timeout: 20_000 }).catch(() => null);
    const info = { loggedIn, url: shotPage.url(), hint: loggedIn ? "已登录" : "请在浏览器窗口完成登录后调用 xiumi_status 确认" };
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(info, null, 2) },
        ...(png ? [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] : []),
      ],
    };
  }),
);

server.registerTool(
  "xiumi_list_template_tags",
  {
    title: "列出模板分类",
    description: "列出秀米图文模板的一级分类（标题、卡片、图片、布局、SVG、组件等）及其子分类 ID，可配合 xiumi_search_templates 的 tagIds 使用。",
    inputSchema: {},
  },
  guarded(async () => {
    const page = await getStudioPage();
    await ensureStudio(page);
    return json(await listTemplateTags(page));
  }),
);

server.registerTool(
  "xiumi_search_templates",
  {
    title: "检索秀米模板",
    description:
      "按中文关键词和/或分类 ID 检索秀米模板库，返回模板 ID、标签、纯文本摘要。结果会缓存，可直接把模板 ID 交给 xiumi_insert_template。",
    inputSchema: {
      query: z.string().optional().describe("中文关键词，如「引导关注」「节日标题」「分割线」"),
      tagIds: z.array(z.number().int()).optional().describe("分类 ID，来自 xiumi_list_template_tags"),
      limit: z.number().int().min(1).max(20).optional().describe("返回条数，默认 8"),
      pageNo: z.number().int().min(0).optional().describe("翻页，从 0 开始"),
      includeHtml: z.boolean().optional().describe("是否返回模板 HTML（体积较大，默认 false）"),
    },
  },
  guarded(
    async ({
      query,
      tagIds,
      limit,
      pageNo,
      includeHtml,
    }: {
      query?: string;
      tagIds?: number[];
      limit?: number;
      pageNo?: number;
      includeHtml?: boolean;
    }) => {
      const page = await getStudioPage();
      await ensureStudio(page);
      const result = await searchTemplates(page, { query, tagIds, limit, pageNo });
      if (result.error) return fail(result.error);
      for (const item of result.items) templateCache.set(item.id, item.raw);
      return json({
        total: result.total,
        items: result.items.map((t) => ({
          id: t.id,
          tags: t.tags,
          text: t.text,
          ...(includeHtml ? { html: t.html } : {}),
        })),
      });
    },
  ),
);

server.registerTool(
  "xiumi_insert_template",
  {
    title: "插入秀米模板",
    description:
      "把模板插入当前文章（追加到末尾），返回新增组件的 ID、文本槽和图片槽。插入后可用 xiumi_fill_text 填字、xiumi_set_image 换图。",
    inputSchema: {
      templateId: z.number().int().describe("模板 ID，来自 xiumi_search_templates"),
      at: z.enum(["end", "cursor"]).optional().describe("插入位置：end 追加到文末（默认），cursor 插入到当前光标处"),
    },
  },
  guarded(async ({ templateId, at }: { templateId: number; at?: "end" | "cursor" }) => {
    const page = await getStudioPage();
    await ensureStudio(page);
    const cached = templateCache.get(templateId);
    let template = cached;
    if (!template) {
      const found = await page.evaluate(
        async ({ id, api }) => {
          const res = await fetch(`${api}?template_ids=${id}&tag_category=paper-cp&template_category=paper-cp`, {
            credentials: "include",
          });
          const data = await res.json();
          if (data && data.code === 0 && data.data && data.data.templates) {
            const hit = data.data.templates.find((t: { template_id: number }) => t.template_id === id);
            if (hit) return hit;
          }
          return null;
        },
        { id: templateId, api: "https://xiumi.us/api/templates" },
      );
      template = (found as Record<string, unknown> | null) ?? undefined;
    }
    if (!template) {
      return fail(`模板 ${templateId} 不在缓存中，也未能从接口取回。请先调用 xiumi_search_templates 选中它。`);
    }
    const inserted = await insertTemplate(page, template as { template_id: number }, { at });
    if (!inserted.ok) return fail(inserted.error ?? "插入失败");
    const comps = await getTopLevelComps(page);
    const preview = comps.find((c) => c.id === inserted.compId)?.text ?? "";
    return json({
      compIds: inserted.comps.map((c) => c.id),
      comps: inserted.comps.map((c) => ({
        compId: c.id,
        textSlots: c.slots.length,
        imageSlots: c.images,
        slotTexts: c.slots.map((s, index) => ({ index, text: s.text })),
      })),
      preview,
    });
  }),
);

server.registerTool(
  "xiumi_fill_text",
  {
    title: "填充文本槽",
    description:
      "把某个组件内第 slotIndex 个文本槽替换为指定文字（支持 \\n 换行）。文本槽编号从 0 开始，顺序与组件内可见文字一致。",
    inputSchema: {
      compId: z.string().describe("组件 ID（tn-uuid），来自 xiumi_insert_template 或 xiumi_get_comps"),
      slotIndex: z.number().int().min(0).describe("文本槽序号，从 0 开始"),
      text: z.string().describe("要写入的文字"),
    },
  },
  guarded(async ({ compId, slotIndex, text }: { compId: string; slotIndex: number; text: string }) => {
    const page = await getStudioPage();
    await ensureStudio(page);
    const result = await fillText(page, compId, slotIndex, text);
    return result.ok ? json(result) : fail(result.error ?? "填充失败");
  }),
);

server.registerTool(
  "xiumi_delete_comp",
  {
    title: "删除组件",
    description: "删除文章里的一个顶层组件（按组件 ID）。适用于删除误插入的模板或多余的空行/分割线。",
    inputSchema: {
      compId: z.string().describe("组件 ID，来自 xiumi_get_comps 或 xiumi_insert_template"),
    },
  },
  guarded(async ({ compId }: { compId: string }) => {
    const page = await getStudioPage();
    await ensureStudio(page);
    const result = await deleteComp(page, compId);
    return result.ok ? json({ ok: true, compId }) : fail(result.error ?? "删除失败");
  }),
);

server.registerTool(
  "xiumi_set_image",
  {
    title: "替换/上传图片",
    description:
      "把组件内第 slotIndex 个图片槽替换成指定图片。支持本地文件（filePath）或网络图片（url）；图片会先上传到秀米图床再写入排版。",
    inputSchema: {
      compId: z.string().describe("组件 ID，来自 xiumi_get_comps / xiumi_insert_template"),
      slotIndex: z.number().int().min(0).optional().describe("图片槽序号，从 0 开始，默认 0"),
      filePath: z.string().optional().describe("本地图片绝对路径（png/jpg/gif/webp）"),
      url: z.string().url().optional().describe("网络图片 URL"),
    },
  },
  guarded(
    async ({ compId, slotIndex, filePath, url }: { compId: string; slotIndex?: number; filePath?: string; url?: string }) => {
      if ((filePath && url) || (!filePath && !url)) {
        return fail("filePath 和 url 必须且只能提供一个");
      }
      const page = await getStudioPage();
      await ensureStudio(page);

      let base64: string;
      let fileName: string;
      let mime: string;
      if (filePath) {
        const buf = await readFile(filePath);
        base64 = buf.toString("base64");
        fileName = basename(filePath);
        const ext = extname(filePath).toLowerCase();
        mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/png";
      } else {
        const res = await fetch(url!);
        if (!res.ok) return fail(`下载图片失败：HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        base64 = buf.toString("base64");
        fileName = `image-${Date.now()}.png`;
        mime = (res.headers.get("content-type") || "image/png").split(";")[0];
      }

      const uploaded = await uploadImage(page, base64, fileName, mime);
      if (!uploaded.ok || !uploaded.url) return fail(uploaded.error ?? "图片上传失败");
      const applied = await setImage(page, compId, slotIndex ?? 0, uploaded.url);
      if (!applied.ok) return fail(applied.error ?? "写入图片失败");
      return json({ ok: true, compId, slotIndex: slotIndex ?? 0, src: applied.src });
    },
  ),
);

server.registerTool(
  "xiumi_set_typography",
  {
    title: "调整字体排版",
    description:
      "批量调整正文（或全部文本）的字号、行距、字距和颜色，用于统一全文排版。scope=body 只改长段落，scope=all 改包括标题在内的所有文本槽。",
    inputSchema: {
      scope: z.enum(["body", "all"]).optional().describe("body 仅正文段落（默认），all 全部文本"),
      minChars: z.number().int().min(1).optional().describe("body 模式下视为正文的最少字符数，默认 25"),
      fontSizePercent: z.number().min(50).max(400).optional().describe("字号，百分比（100 = 16px）"),
      lineHeight: z.number().min(1).max(3).optional().describe("行距倍数，如 1.9"),
      letterSpacingPx: z.number().min(0).max(10).optional().describe("字距，单位 px，如 1"),
      color: z.string().optional().describe("文字颜色，如 #333333"),
    },
  },
  guarded(
    async (args: {
      scope?: "body" | "all";
      minChars?: number;
      fontSizePercent?: number;
      lineHeight?: number;
      letterSpacingPx?: number;
      color?: string;
    }) => {
      const page = await getStudioPage();
      await ensureStudio(page);
      const result = await setTypography(page, args);
      return result.ok ? json(result) : fail(result.error ?? "调整失败");
    },
  ),
);

server.registerTool(
  "xiumi_set_meta",
  {
    title: "设置标题与摘要",
    description: "设置当前图文的标题和微信分享摘要（摘要受秀米字数限制）。",
    inputSchema: {
      title: z.string().optional().describe("图文标题"),
      summary: z.string().optional().describe("微信分享摘要"),
    },
  },
  guarded(async ({ title, summary }: { title?: string; summary?: string }) => {
    const page = await getStudioPage();
    await ensureStudio(page);
    const result: Record<string, string> = {};
    if (title !== undefined) result.title = await setTitle(page, title);
    if (summary !== undefined) result.summary = await setSummary(page, summary);
    return json(result);
  }),
);

server.registerTool(
  "xiumi_get_comps",
  {
    title: "查看文章结构",
    description: "列出当前文章的顶层组件（ID、文字预览、文本槽数量），用于检查排版顺序和确认要填字的组件。",
    inputSchema: {},
  },
  guarded(async () => {
    const page = await getStudioPage();
    await ensureStudio(page);
    return json(await getTopLevelComps(page));
  }),
);

server.registerTool(
  "xiumi_get_html",
  {
    title: "导出公众号 HTML",
    description:
      "通过秀米「导出 → 继续用复制粘贴」把当前文章导出为公众号可用的最终 HTML（内联样式）。设置 saveToFile 时写入文件并只返回路径和长度，避免长文占用上下文。",
    inputSchema: {
      saveToFile: z.string().optional().describe("保存到的绝对路径（.html）；不填则直接返回 HTML 文本"),
    },
  },
  guarded(async ({ saveToFile }: { saveToFile?: string }) => {
    const page = await getStudioPage();
    await ensureStudio(page);
    const result = await exportHtml(page);
    if (!result.ok) return fail(result.error ?? "导出失败");
    if (saveToFile) {
      await writeFile(saveToFile, result.html, "utf8");
      return json({ path: saveToFile, length: result.html.length, preview: result.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200) });
    }
    return { content: [{ type: "text" as const, text: result.html }] };
  }),
);

server.registerTool(
  "xiumi_save",
  {
    title: "保存到秀米",
    description: "保存当前图文到秀米账号（需登录）。返回是否成功及提示信息。",
    inputSchema: {},
  },
  guarded(async () => {
    const page = await getStudioPage();
    await ensureStudio(page);
    return json(await saveArticle(page));
  }),
);

server.registerTool(
  "xiumi_screenshot",
  {
    title: "截取文章画布",
    description: "截取当前文章画布并返回 PNG，用于检查排版效果。",
    inputSchema: {},
  },
  guarded(async () => {
    const page = await getStudioPage();
    await ensureStudio(page);
    const png = await screenshotPaper(page);
    return { content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] };
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
