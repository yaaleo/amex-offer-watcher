# 更新日志 / Changelog

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
