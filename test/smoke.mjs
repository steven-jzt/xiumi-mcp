/**
 * CI smoke test: starts the MCP server over stdio and verifies that all tools
 * are registered. This does not launch a browser, so it runs on headless CI.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REQUIRED_TOOLS = [
  "xiumi_start",
  "xiumi_status",
  "xiumi_login",
  "xiumi_open_article",
  "xiumi_list_template_tags",
  "xiumi_search_templates",
  "xiumi_insert_template",
  "xiumi_fill_text",
  "xiumi_set_image",
  "xiumi_delete_comp",
  "xiumi_set_typography",
  "xiumi_set_meta",
  "xiumi_get_comps",
  "xiumi_get_html",
  "xiumi_save",
  "xiumi_screenshot",
];

const timeout = new Promise((_, reject) => {
  setTimeout(() => reject(new Error("smoke test timed out after 30s")), 30_000).unref();
});

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.ts"],
    cwd: process.cwd(),
    env: { ...process.env },
    stderr: "inherit",
  });

  const client = new Client({ name: "xiumi-mcp-ci", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));

  console.log(`registered tools: ${names.length}`);
  console.log(names.sort().join("\n"));

  if (missing.length > 0) {
    throw new Error(`missing tools: ${missing.join(", ")}`);
  }
  if (names.length !== REQUIRED_TOOLS.length) {
    throw new Error(`expected ${REQUIRED_TOOLS.length} tools, got ${names.length}`);
  }

  await client.close();
  console.log("smoke test passed");
}

Promise.race([main(), timeout])
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
