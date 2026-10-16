# cc-haha 许可说明 / Licensing guide

当前许可为 **cc-haha Community Source License 1.0**，完整英文条款见
[LICENSE](LICENSE)。这是自定义的源码可用许可，不是 MIT、Apache-2.0、BUSL，
也不是 OSI 认可的开源许可证。本页仅解释条款，实际授权以 LICENSE 及适用的独立许可为准。

## 允许与需要授权的用途

| 场景 | 当前许可的处理 |
| --- | --- |
| 个人非商业使用、学习、研究、修改 | 允许 |
| 企业内部自用：内部部署、内部工具、仅供自身内部需要的修改 | 允许；不包括下列需要授权的商业盈利活动 |
| 员工因正常内部工作领取工资 | 不会仅因此被认定为需要授权的商业盈利活动 |
| 免费发布非商业社区 fork、修改版或提供非商业远程访问 | 允许，须履行来源署名、许可保留和修改说明要求 |
| 使用 cc-haha 接单、承接付费委托、开发或交付收费的代码、文档、设计等成果 | 需事先取得书面商业授权，即使交付物不包含 cc-haha 源码 |
| 使用 cc-haha 开发用于对外商业销售或许可的软件或其他成果 | 需事先取得书面商业授权 |
| 对 cc-haha 或其衍生版本进行收费定制、二次开发、集成、部署或维护 | 需事先取得书面商业授权 |
| 换皮售卖、收费分发、商业集成或商业再分发 cc-haha 或其衍生版本 | 需事先取得书面商业授权，不以是否构成竞争产品为条件 |
| 面向第三方提供付费托管、SaaS、托管服务或远程访问 | 需事先取得书面商业授权 |
| 表面免费，但通过广告、佣金或捆绑收费产品、服务变现 | 同样需事先取得书面商业授权 |

**企业内部自用可用；接单、对外商业盈利、收费修改和二次开发须事先取得书面商业授权。**
内部部署、员工操作、公开源码或保留署名，均不能豁免上述需要授权的活动。
限制不以是否与 cc-haha 竞争为条件，不保留“非竞争性商业集成或再分发”的免费例外。
输入、输出的所有权不会仅因使用工具转移给本项目，但使用工具生成商业交付物仍须遵守上述用途限制；
直接复制的软件代码还受其适用许可约束。私人修改及独立代码不因此被要求公开。
仅为非商业社区项目维护提供自愿捐赠、且不换取付费访问、功能或服务，本身不视为需要授权的商业盈利活动。
商业授权联系：**relakkes@gmail.com**。第三方权利人拥有的部分可能还需另行取得其授权。

## 二次分发必须显著标明来源

对于适用新许可的代码和修改版，应包含完整 LICENSE、版权和第三方许可声明，并展示：

```text
Based on cc-haha: https://github.com/NanmiCoder/cc-haha
Copyright (c) 2026 cc-haha
```

- 源码分发：放在主 README 靠前位置。
- 图形界面应用：放在正常可访问的“关于”或法律信息页面。
- 二进制分发：在产品介绍或随包文档中展示，并随包附带许可文件。
- 纯命令行分发：在正常帮助或许可输出中展示。
- 远程访问：通过正常可访问的法律或许可页面提供完整声明；嵌入组件在宿主相应位置明确该组件来源。
- 修改版：明确标记为非官方或修改版，并说明实质性修改，不得暗示官方背书。

这些要求不意味着必须使用 cc-haha 的 Logo，也不要求“修改一定比例的代码”。
修改名称、界面或大量代码不能自动豁免商业限制和署名义务。
本许可没有强制公开私人修改或独立编写代码的条款。

## 从 MIT 迁移的边界

1. 此次变更前的主分支提交
   [`755a18edb7e7519a12f5c7ee4265c9eb4f2ed508`](https://github.com/NanmiCoder/cc-haha/commit/755a18edb7e7519a12f5c7ee4265c9eb4f2ed508)
   使用 MIT；后续若在迁移前有其他 MIT 提交，也以相应版本实际分发的许可为准。
2. 旧版 MIT 授权继续有效；已经按 MIT 获得的代码不会因替换根目录 LICENSE 而失去原授权。
   历史全文可在[旧提交的 LICENSE](https://github.com/NanmiCoder/cc-haha/blob/755a18edb7e7519a12f5c7ee4265c9eb4f2ed508/LICENSE) 中查看；当前仓库不再单独附带历史 MIT 文件，也不向后续新增代码授予 MIT 权利。
3. 新许可只在相应权利人有权授权的范围内生效。第三方依赖、内嵌代码、单独授权的文件及既有 MIT 贡献，
   继续保留适用的许可与通知，参见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) 及文件、目录中的声明。
4. 本变更不能追溯要求旧版 MIT 使用者在 README 或界面新增署名，也不能阻止其按 MIT 对旧代码进行合规商用。
   旧版 MIT 原本要求的版权和许可保留义务仍然存在。
5. 对新增贡献，应在接受前明确贡献者的授权；不能仅靠修改根目录文件宣称取得所有贡献者的版权或重新许可权。

本次迁移没有新增业务代码，不能把已经按 MIT 发布的代码变成只能按新许可使用。
任何人仍可从历史版本取得这些代码并按 MIT 合规修改、分发和商用。
新增限制主要作用于未来由有权授权者按新许可发布、且没有其他独立授权的新增内容。

本次迁移仅更新源码仓库的许可文本和说明，不发布新的安装包。
后续分发适用新许可的安装包时，应随包携带 LICENSE、NOTICE 及适用的第三方或单独授权代码所需的许可声明，
并核查上面的可见署名要求；既有发布包不会被本次源码变更自动更新。

## English summary

The governing terms are in [LICENSE](LICENSE). Noncommercial personal,
educational, and research use, and an organization's own internal operations,
internal tools, and internal-only modifications are allowed. Ordinary employee
salary for otherwise permitted internal work is not by itself prohibited.

Separate prior written commercial permission is required for paid client work,
commissioned development, creating software or other deliverables for commercial
sale or licensing, paid customization or secondary development, commercial
integration or redistribution, and paid hosting, SaaS, or managed access.
These restrictions also cover monetization through advertising, commissions,
or paid bundles, whether or not the offering competes with cc-haha. They apply
to paid client work even when the delivered output contains no cc-haha code.
Internal deployment, employee access, attribution, or public source code does
not exempt a restricted activity. Output ownership is not transferred, but
using the Software to create commercial deliverables is still restricted.

Free noncommercial community forks, redistribution, and remote access are allowed
with the required notices, visible source attribution, and identification of
material modifications.

Redistributions must carry the license and applicable notices. Source attribution
belongs near the beginning of the main README, in an accessible About or legal
page for graphical applications, in binary product descriptions or accompanying
documentation, and in normal help or license output for CLI-only distributions.
Private changes and independently written code need not be published.

Existing MIT grants remain valid. Historical terms remain available in the
[pre-transition LICENSE](https://github.com/NanmiCoder/cc-haha/blob/755a18edb7e7519a12f5c7ee4265c9eb4f2ed508/LICENSE).
The current repository does not carry a separate historical MIT file or grant
MIT rights to later additions. Third-party code and separately licensed contributions keep their own
terms. This is a source-available license, not an OSI-approved open-source license.
Future contributions must be accepted under clearly agreed terms; this change
does not transfer contributors' copyright or blanket relicensing authority.

This change adds no product code and cannot make previously MIT-licensed code
exclusive to the new terms. Historical versions remain available for compliant
MIT use, modification, redistribution, and commercialization. The new restrictions
primarily cover future additions that their rights holders release only under
the new license.

This source-only change does not publish or update installers. Future binary
releases must carry the applicable license files and meet the attribution
requirements. Commercial licensing: **relakkes@gmail.com**.
