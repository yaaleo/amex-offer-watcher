# 隐私政策 / Privacy Policy

**生效日期 / Effective date: 2026-09-24**

## 中文

### 收集和处理的数据

扩展仅为提供用户主动请求的 Offer 读取功能而处理以下信息：

- 用户输入的 Amex 链接、目标奖励数值、轮次间隔和提醒阈值；
- 用户可选填写的 ntfy 主题；
- 每轮读取结果，包括卡名、Offer 文本、数值、时间、耗时、来源和错误详情；
- Amex 页面中定位 `Continue`、`Apply Now`、`Offer Terms` 和具体奖励所需的页面文本与结构。

扩展不会故意收集姓名、地址、电话号码、电子邮箱、社会安全号码、收入、账户密码、银行卡号或申请表输入内容。扩展不会填写或提交申请。

### 本地存储

设置和最近 200 条历史记录保存在 Chrome 的扩展本地存储中。维护者没有服务器，也不会接收这些本地数据。用户可以在扩展中清空历史记录；卸载扩展会删除 Chrome 管理的扩展本地数据。

### 网络通信

- 扩展会访问用户指定的 American Express 页面，以完成用户主动启动的 Offer 读取流程。
- 未配置 ntfy 时，扩展不会把 Offer 历史发送给维护者或其他通知服务。
- 用户主动配置 ntfy 主题后，扩展会通过 HTTPS 向 `https://ntfy.sh` 发送通知。通知可能包含主题、卡名、Offer 金额、目标数值、发现时间和错误摘要。该数据受 ntfy 自身隐私政策和服务条款约束。

### 不出售数据

维护者不出售、出租或用于广告、信用评估、贷款决策、用户画像或数据经纪活动的用户数据。

### 数据控制

用户可以不配置 ntfy，从而保持全部历史记录仅存储在本机。用户可以随时停止扩展、清空历史或卸载扩展。

### 政策变更

若未来版本改变数据处理方式，将在仓库和产品界面中更新本政策并说明重要变化。

## English

### Data processed

The extension processes only the information needed to provide the user-requested offer-reading feature:

- The Amex URL, target reward value, retry delay, and alert threshold entered by the user;
- An optional ntfy topic entered by the user;
- Per-attempt results, including card name, offer text, numeric value, timestamp, duration, source, and error details;
- Amex page text and structure needed to locate `Continue`, `Apply Now`, `Offer Terms`, and the exact reward.

The extension does not intentionally collect names, addresses, phone numbers, email addresses, Social Security numbers, income, account passwords, card numbers, or application-form input. It does not fill out or submit applications.

### Local storage

Settings and the latest 200 history entries are stored in Chrome extension local storage. The maintainer operates no server and does not receive this local data. Users can clear history in the extension. Uninstalling the extension removes extension-local data managed by Chrome.

### Network communication

- The extension accesses American Express pages selected by the user to perform the offer-reading process started by the user.
- If ntfy is not configured, offer history is not transmitted to the maintainer or another notification service.
- If the user voluntarily configures an ntfy topic, the extension sends notifications over HTTPS to `https://ntfy.sh`. A notification may include the topic, card name, offer amount, target value, discovery time, and an error summary. That data is governed by ntfy's own privacy policy and terms.

### No sale of data

The maintainer does not sell or rent user data or use it for advertising, creditworthiness assessment, lending decisions, profiling, or data-broker activity.

### User control

Users can leave ntfy unconfigured so all history remains local. Users can stop the extension, clear history, or uninstall it at any time.

### Policy changes

If a future release changes data practices, this policy will be updated in the repository and material changes will be disclosed in the product interface.
