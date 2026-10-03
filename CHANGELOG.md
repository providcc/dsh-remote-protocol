# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

## [1.0.1] - 2026-10-03

### 变更

- **没有代码变更**，这一版唯一的目的是成为**第一个带 provenance 的发布**。
  `1.0.0` 是用 npm 的 Automation token 发的：pnpm 先试 OIDC，换票拿到 404 后**静默回落**成
  token 发布，于是包发出去了、工作流也绿了，但 `/-/npm/v1/attestations/dsh-remote-wire@1.0.0`
  是 Not found。已发布出去的版本永远补不上 attestation（npm 侧既定行为），所以只能往前发一版。
- 发布凭据改为 **GitHub OIDC / Trusted Publishing**：Release 工作流的 Publish 步骤不再设
  `NODE_AUTH_TOKEN`（token 在场就会掩盖 OIDC 失败），并新增一步 `Verify provenance landed`
  ——发布后 60s 内查不到 attestation 就让工作流红，并直接把配置命令印在报错里。

## [1.0.0] - 2026-10-03

### 新增

- DSH Remote Control 线协议的首次公开发布。
- 基于 `tweetnacl` 的 XSalsa20-Poly1305 密封记录加密（`seal` / `open`）。
- PSK 生成与 `c2h` / `h2c` 两把方向密钥的派生，并支持在无 CSPRNG 的运行时上用计数器 nonce。
- 中继控制帧与 `cmd.*` / `ev.*` 载荷目录的 zod schema 与解析器。
- 中继 → 端点、主机 → 客户端消息的类型化出站构造器。
- `dshr:/p?...` 配对 URI 编解码与 6 位码工具。
- 会话 / 主机 / 命令 id 生成。
- 跨平台防休眠命令构造器（`caffeinate`、`systemd-inhibit`）。

[未发布]: https://github.com/providcc/dsh-remote-protocol/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/providcc/dsh-remote-protocol/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.0.0
