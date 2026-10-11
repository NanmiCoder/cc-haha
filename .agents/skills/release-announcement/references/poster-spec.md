# `poster-spec.json` 格式

运行 `scan` 后，以最新 release note 填写 JSON。字段：

```json
{
  "version": "0.6.7",
  "product": "Claude Code Haha",
  "features": [
    {"title": "侧边对话", "body": "输入 /btw，在右侧开启独立的临时对话，不打断主任务。"}
  ],
  "extras": [
    {"title": "模型与供应商", "headline": "新版模型与映射", "body": "依据本版说明压缩成一句话。"}
  ],
  "fixes": [
    {"title": "超大会话打不开", "body": "超过 20MB 的历史可以继续打开。"}
  ],
  "contributors": [
    {"login": "example-user", "contribution": "此人本次被署名的贡献"}
  ],
  "install_note": "仅在发布说明明确写有安装提醒时填写。",
  "footer_url": "github.com/NanmiCoder/cc-haha"
}
```

- `version`、`features`、`fixes`、`contributors` 必填；`extras`、`install_note`、`footer_url` 可省略。纯修复版填 `"features": []`，纯功能版填 `"fixes": []`，两者不能同时为空。没有署名贡献者时 `contributors` 为 `[]`。
- `features` 一般选 2–4 项，大版本最多 6 项；按用户价值排序，第一项绘制在橙色首屏作为「本版重点」。其他功能为单列编号，说明不必手动添加换行。`fixes` 一般不超过 9 项，硬上限 12 项；`extras` 用于补充输入、模型或供应商变化，合并在「更多变化」区，不用于堆放剩余 commit。
- 现有 JSON 无需新增样式字段即可使用新版模板。配色和字号统一由脚本维护；长标题、贡献说明、ID 和 URL 会自动换行，超长英文串仅在超出可用宽度时拆分，不裁切或省略内容。
- `render --scan` 会校验版本及贡献者 ID 必须是 release note 中文部分的明确署名候选。普通提及不算署名；不要把示例 ID 写入真实结果。
- 测试或离线排版时，贡献者可以另给 `avatar_path` 并显式传 `--allow-offline-avatars`；正式生成禁止该选项，必须实时核验公开 GitHub 账号与头像。
- 正式图保留所有已核验、已署名的贡献者；如果名字很多，可以缩短每人的贡献概述，不能遗漏账号或用假头像填位。
