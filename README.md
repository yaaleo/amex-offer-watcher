# Amex Offer Watcher

> **非官方项目 / Unofficial project**
> 本项目与 American Express Company 及其关联公司没有隶属、授权、赞助或背书关系。
> This project is not affiliated with, authorized by, sponsored by, or endorsed by American Express Company or any of its affiliates.
>
> **仅用于浏览器扩展技术交流、个人学习和低频个人测试。禁止用于违法、欺诈、规避限制、高频请求、批量操作或其他滥用行为。**
> **For browser-extension research, personal learning, and low-frequency personal testing only. Illegal, fraudulent, evasive, high-volume, bulk, or otherwise abusive use is prohibited.**

[中文](#中文说明) · [English](#english)

---

## 中文说明

### 项目简介

Amex Offer Watcher 是一个本地运行的 Chrome Manifest V3 扩展。用户提供 American Express 美国信用卡推荐页、产品页或申请页链接，并设置目标奖励数值。扩展会在自己管理的后台最小化无痕窗口中打开页面，进入申请页，读取当前申请流程能够公开显示的具体 Welcome Offer，并保存逐轮历史。

扩展只读取 Offer，不填写申请资料，不点击提交申请按钮，也不接受卡片。

### 主要功能

- 支持 Amex 推荐页、美国信用卡产品页和申请页链接。
- 自动执行推荐页的 `Continue → Apply Now` 或产品页的 `Apply Now`。
- 从申请数据和 `Offer Terms` 中读取具体奖励。
- 严格排除 `As High As`、`Up to`、`As much as` 等宣传上限。
- 支持 Membership Rewards、Hilton Honors、Marriott Bonvoy、Delta Miles、Statement Credit、Cash Back 和 Free Night Reward。
- 允许用户自定义目标数值、轮次间隔和连续失败提醒阈值。
- 保存最近 200 条逐轮记录，包括金额、时间、耗时、来源和错误详情。
- 达到目标后停止、保留成功窗口，并发送 Chrome 通知。
- 可选通过 `ntfy.sh` 发送手机提醒。
- 不包含 VPN、代理、IP 检测或自动切换功能。

### 重要限制

部分个人卡的 Amex 页面只在用户提交申请后生成精确 Offer。遇到这种情况时，扩展会停止并记录“提交申请后显示”，不会填写或提交申请，也不会把宣传上限误认为精确结果。

Amex 可以随时修改页面结构、Offer 规则或访问限制，因此本扩展无法保证持续可用，也无法保证任何用户能够取得特定 Offer。

本项目不授予用户违反 American Express 条款、绕过验证码或访问控制、规避 `403`/`429`、轮换 IP、隐藏自动化流量或制造异常负载的权利。若网站显示限制、阻止访问或要求停止，用户应立即停止运行。

### 推荐链接披露

扩展首次安装时会预填维护者提供的 Amex 推荐链接。若用户保留该链接并最终通过对应推荐流程申请卡片，推荐人可能获得 American Express 提供的推荐奖励。该链接不会保证用户取得更高 Offer。

用户可以在点击“开始”前删除或替换该链接。扩展不会把用户自己输入的链接替换成维护者的推荐链接。

### 安装方法

#### 从 GitHub Release 安装

1. 打开本仓库的 **Releases** 页面，下载最新的 `amex-offer-watcher-版本号.zip`。
2. 解压 ZIP 文件。
3. 在 Chrome 地址栏打开 `chrome://extensions`。
4. 打开右上角的“开发者模式”。
5. 点击“加载已解压的扩展程序”。
6. 选择刚才解压出的 `amex-300k-extension` 文件夹。
7. 打开该扩展的“详情”，启用“允许在无痕模式下运行”。
8. 建议将扩展固定到 Chrome 工具栏。

Chrome 扩展不能直接从 ZIP 文件运行，必须先解压。

#### 从源码安装

1. 克隆或下载本仓库。
2. 在 Chrome 打开 `chrome://extensions` 并启用开发者模式。
3. 点击“加载已解压的扩展程序”。
4. 选择包含 `manifest.json` 的仓库根目录。
5. 在扩展详情中启用“允许在无痕模式下运行”。

### 使用方法

1. 点击工具栏中的 Amex Offer Watcher 图标。
2. 填写或确认 Amex 推荐页、产品页或申请页链接。
3. 填写目标奖励数值，例如积分目标 `300000`、里程目标 `90000` 或返现目标 `250`。
4. 设置每轮间隔和连续未读取提醒阈值。
5. 如需手机提醒，展开 ntfy 设置并填写自己订阅的随机主题；不需要时保持为空。
6. 点击“开始”。
7. 扩展会创建一个独立的最小化无痕窗口。已有普通窗口和无痕窗口不会被关闭。
8. 每轮结果会写入“历史记录”。低于目标时继续下一轮；达到目标时停止并显示成功窗口。
9. 随时点击“停止”即可结束运行并关闭扩展管理的窗口。

### 超时与提醒

- 每轮从创建窗口开始最多等待 50 秒。
- 页面返回 `403`、`429`、`5xx` 或明确错误页时，会记录错误并进入下一轮。
- 连续未读取达到用户设定阈值时，会发送 Chrome 桌面通知。
- 配置 ntfy 后，通知内容会通过 HTTPS 发送到 `ntfy.sh`。详情见 [隐私政策](PRIVACY.md)。

### 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 在本机保存设置和最近 200 条历史记录 |
| `alarms` | 控制每轮超时和下一轮调度 |
| `notifications` | 发送成功及连续失败提醒 |
| `tabs` / `windows` | 创建、管理扩展自己的后台无痕窗口和标签页 |
| Amex 域名访问 | 打开申请流程并读取 Offer Terms |
| `ntfy.sh` | 仅在用户主动配置 ntfy 主题后发送可选手机提醒 |

### 本地测试

```bash
node --check background.js
node --check content.js
node --check offer-parser.js
node --check print-guard.js
node --check popup.js
node tests/offer-parser.test.js
node tests/content-error-page.test.js
node tests/background-smoke.test.js
python3 -m py_compile tests/live-headless-qa.py
```

实时测试脚本会真实访问 Amex 页面，只应由了解其行为的维护者低频运行。

### 法律、隐私和许可

- 使用前请阅读 [免责声明](DISCLAIMER.md)。
- 所有使用者必须遵守 [可接受使用政策](ACCEPTABLE_USE.md)。
- 数据处理方式见 [隐私政策](PRIVACY.md)。
- 安全问题报告方式见 [安全政策](SECURITY.md)。
- 本项目采用个人、非商业、未修改使用许可，详见 [LICENSE](LICENSE)。

---

## English

### Overview

Amex Offer Watcher is a locally running Chrome Manifest V3 extension. The user supplies an American Express U.S. card referral page, product page, or application page and chooses a target reward value. The extension opens the page in its own minimized incognito window, enters the application flow, reads the exact Welcome Offer that the current flow makes available before submission, and stores per-attempt history.

The extension only reads offers. It does not fill application fields, click the application submission button, submit an application, or accept a card.

### Features

- Supports Amex referral pages, U.S. card product pages, and application pages.
- Automatically follows `Continue → Apply Now` on referral pages or `Apply Now` on product pages.
- Reads exact rewards from application data and `Offer Terms`.
- Strictly rejects promotional ceilings such as `As High As`, `Up to`, and `As much as`.
- Supports Membership Rewards, Hilton Honors, Marriott Bonvoy, Delta Miles, statement credits, cash back, and Free Night Rewards.
- Lets the user choose the target value, delay between attempts, and consecutive-failure alert threshold.
- Keeps the latest 200 attempt records with the result, time, duration, source, and error details.
- Stops at the target, preserves the successful window, and sends a Chrome notification.
- Optionally sends mobile notifications through `ntfy.sh`.
- Contains no VPN, proxy, IP-detection, or automatic IP-switching functionality.

### Important limitation

Some personal-card flows generate the exact offer only after the user submits an application. In that situation, the extension stops and records “Shown after application submission.” It does not fill or submit the application and does not treat the promotional ceiling as an exact result.

Amex may change its page structure, offer rules, or access controls at any time. This extension cannot guarantee continued operation or the availability of any particular offer.

This project grants no right to violate American Express terms, bypass CAPTCHAs or access controls, evade `403`/`429` responses, rotate IP addresses, conceal automated traffic, or create abnormal load. If a site limits or blocks access or requests that activity stop, the user must stop immediately.

### Referral-link disclosure

On first installation, the extension pre-fills an Amex referral link supplied by the maintainer. If a user keeps that link and ultimately applies through the corresponding referral flow, the referrer may receive a referral reward from American Express. The referral link does not guarantee a better offer for the user.

The user may delete or replace the link before clicking **Start**. The extension does not replace a link entered by the user with the maintainer's referral link.

### Installation

#### Install from a GitHub Release

1. Open this repository's **Releases** page and download the latest `amex-offer-watcher-version.zip` file.
2. Extract the ZIP archive.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted `amex-300k-extension` folder.
7. Open the extension's **Details** page and enable **Allow in Incognito**.
8. Pin the extension to the Chrome toolbar if desired.

Chrome cannot run this unpacked extension directly from a ZIP archive; extract it first.

#### Install from source

1. Clone or download this repository.
2. Open `chrome://extensions` and enable Developer mode.
3. Click **Load unpacked**.
4. Select the repository root containing `manifest.json`.
5. Enable **Allow in Incognito** on the extension's Details page.

### Usage

1. Click the Amex Offer Watcher toolbar icon.
2. Enter or confirm an Amex referral, product, or application URL.
3. Set the target reward value, such as `300000` points, `90000` miles, or `250` dollars of cash back.
4. Choose the delay between attempts and the consecutive-failure alert threshold.
5. For optional mobile alerts, expand the ntfy section and enter a random topic that you subscribe to; otherwise leave it blank.
6. Click **Start**.
7. The extension creates a separate minimized incognito window. It does not close existing regular or incognito windows.
8. Each attempt appears in **History**. Results below the target start another attempt; reaching the target stops the run and reveals the successful window.
9. Click **Stop** at any time to end the run and close the extension-managed window.

### Timeouts and notifications

- Each attempt has a 50-second limit measured from window creation.
- HTTP `403`, `429`, `5xx`, and explicit Amex error pages are recorded immediately before the next attempt.
- Chrome sends a desktop notification when consecutive unread attempts reach the user-defined threshold.
- When ntfy is configured, notification content is transmitted to `ntfy.sh` over HTTPS. See the [Privacy Policy](PRIVACY.md).

### Permission usage

| Permission | Purpose |
| --- | --- |
| `storage` | Stores settings and the latest 200 history entries locally |
| `alarms` | Controls attempt timeouts and retry scheduling |
| `notifications` | Sends success and consecutive-failure notifications |
| `tabs` / `windows` | Creates and manages the extension's own incognito window and tabs |
| Amex host access | Opens the application flow and reads Offer Terms |
| `ntfy.sh` | Sends optional mobile alerts only after the user configures a topic |

### Local tests

```bash
node --check background.js
node --check content.js
node --check offer-parser.js
node --check print-guard.js
node --check popup.js
node tests/offer-parser.test.js
node tests/content-error-page.test.js
node tests/background-smoke.test.js
python3 -m py_compile tests/live-headless-qa.py
```

The live QA script makes real requests to Amex and should only be run sparingly by maintainers who understand its behavior.

### Legal, privacy, and license

- Read the [Disclaimer](DISCLAIMER.md) before use.
- Every user must follow the [Acceptable Use Policy](ACCEPTABLE_USE.md).
- See the [Privacy Policy](PRIVACY.md) for data handling.
- See the [Security Policy](SECURITY.md) for vulnerability reporting.
- This project uses a personal, non-commercial, unmodified-use license. See [LICENSE](LICENSE).
