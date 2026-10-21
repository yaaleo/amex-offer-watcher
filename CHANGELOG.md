# 更新日志 / Changelog

## 1.9.5.1 — 2026-10-20

### 中文

- 修复 1.9.5 发布包弹窗仍硬编码为 1.9.4，导致点击图标后重载并立即关闭的问题。
- 弹窗版本号改为读取 manifest.json，后续更新不再需要手动同步第二个版本号。
- 保持 1.9.5 的 Offer 读取、无痕重试和通知流程不变。

### English

- Fixed the v1.9.5 package's stale v1.9.4 popup version check, which reloaded the extension and closed its popup on every click.
- The popup now reads its version from manifest.json, eliminating the duplicate manual version constant.
- Preserved the v1.9.5 offer-reading, incognito retry, and notification behavior.

## 1.9.5 — 2026-10-20

### 中文

- 删除金额消息的纯数字兜底：缺少精确 Offer 原文、或原文含 `As High As` / `Up to` 时，不会记录为成功或发送命中通知。
- 增加消息处理回归测试，防止 AHA 文案被数字字段重新判成精确奖励。

### English

- Removed the numeric-only offer-message fallback. Missing exact-offer text and promotional `As High As` / `Up to` text cannot produce a successful result or target notification.
- Added message-handler regression coverage to prevent numeric fields from overriding rejected promotional wording.

## 1.9.4 — 2026-09-24

### 中文

- 删除旧推荐码，只保留当前默认推荐链接。
- 支持用户提供的 Amex 推荐页、产品页和申请页，并允许自定义目标奖励。
- 支持 Membership Rewards、Hilton、Marriott、Delta、返现和 Free Night 等奖励形式。
- 严格排除 `As High As` 和 `Up to` 宣传上限。
- 对必须提交申请后才能生成精确 Offer 的个人卡给出明确记录，不再误报超时。
- 修正商白卡名识别、Hilton 组合奖励文本和新版申请页读取。
- 保持后台最小化无痕运行，不影响用户已有窗口。
- 保留 50 秒超时、逐轮历史、桌面通知和可选 ntfy 手机提醒。
- 删除全部 VPN、IP 检测和自动切换功能。

### English

- Removed the previous referral code and retained only the current default referral link.
- Supports user-provided Amex referral, product, and application URLs with a custom target value.
- Supports Membership Rewards, Hilton, Marriott, Delta, cash-back, and Free Night reward formats.
- Strictly rejects promotional ceilings such as `As High As` and `Up to`.
- Clearly records personal-card flows that generate exact offers only after submission instead of reporting a timeout.
- Corrected Business Platinum card-name detection, Hilton combined-reward text, and modern application-page reading.
- Keeps the managed incognito window minimized without affecting existing windows.
- Retains the 50-second timeout, per-attempt history, desktop notifications, and optional ntfy mobile alerts.
- Removed all VPN, IP-detection, and automatic IP-switching functionality.
