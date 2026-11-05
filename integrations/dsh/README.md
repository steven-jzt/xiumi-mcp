# DSH 集成（可选）

把 `xiumi-mcp` 注册成 [DeepSeek Harness](https://github.com/deepseek-ai) 的本地 MCP 连接，工具会以 `mcp__xiumi__*` 的形式出现在 Agent 工具列表里。

## 安装

1. 把本目录复制到 DSH 工作区的任意位置（或直接用仓库里的这份）。
2. 修改 `cordis.patch.yml` 里的三个路径：

```yaml
command: 'node'                                   # 建议改成 node 的绝对路径
args:
  - 'C:\\path\\to\\xiumi-mcp\\src\\index.ts'      # 本仓库 src/index.ts 的绝对路径
cwd: 'C:\\path\\to\\xiumi-mcp'
```

3. 用 DSH 的 `plugin_manager` 安装这个目录（`install_bundle`，target 指向本目录）。
4. 重启会话后，调用 `mcp__xiumi__xiumi_status` 验证连接。

## 说明

- `serverName: xiumi` 决定工具前缀；改成别的名字会得到 `mcp__<name>__*`。
- DSH 的 MCP 客户端会以 stdio 方式拉起 `node src/index.ts`，不需要额外编译。
- 如果 DSH 运行在受限文件沙箱里，浏览器子进程可能无法启动；请以完整权限运行，或改用普通终端启动 MCP 服务。
