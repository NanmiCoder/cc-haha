# cc-haha Licensing Guide

The current license is the **cc-haha Community Source License 1.0**; the full terms are in
[LICENSE](LICENSE). This is a custom source-available license. It is not MIT, Apache-2.0, or BUSL,
nor is it an OSI-approved open-source license. This page only explains the terms; the actual grant is governed by LICENSE and any applicable separate licenses.

## Permitted uses and uses that require permission

| Scenario | Treatment under the current license |
| --- | --- |
| Personal noncommercial use, learning, research, modification | Allowed |
| An organization's own internal use: internal deployment, internal tools, modifications solely for its own internal needs | Allowed; excludes the commercial for-profit activities below that require permission |
| Employees receiving salary for ordinary internal work | Not, by itself, treated as a commercial for-profit activity requiring permission |
| Free distribution of noncommercial community forks or modified versions, or providing noncommercial remote access | Allowed, subject to source attribution, license retention, and modification notice requirements |
| Using cc-haha for client work, paid commissions, or to develop or deliver paid code, documentation, designs, or other deliverables | Requires prior written commercial permission, even if the deliverables contain no cc-haha source code |
| Using cc-haha to develop software or other deliverables for external commercial sale or licensing | Requires prior written commercial permission |
| Paid customization, secondary development, integration, deployment, or maintenance of cc-haha or its derivatives | Requires prior written commercial permission |
| Reskinning for sale, paid distribution, commercial integration, or commercial redistribution of cc-haha or its derivatives | Requires prior written commercial permission, regardless of whether it constitutes a competing product |
| Providing paid hosting, SaaS, managed services, or remote access to third parties | Requires prior written commercial permission |
| Nominally free, but monetized through advertising, commissions, or bundled paid products or services | Likewise requires prior written commercial permission |

**Internal use within an organization is allowed; client work, external commercial profit-making, paid modification, and secondary development require prior written commercial permission.**
Internal deployment, employee operation, public source code, or retained attribution do not exempt any of the activities above that require permission.
The restrictions do not depend on whether the activity competes with cc-haha, and there is no free exception for "non-competing commercial integration or redistribution."
Ownership of inputs and outputs is not transferred to this project merely by using the tool, but using the tool to produce commercial deliverables remains subject to the use restrictions above;
directly copied software code is also subject to its applicable license. Private modifications and independent code are not required to be published as a result.
Voluntary donations made solely to support maintenance of a noncommercial community project, in exchange for no paid access, features, or services, are not by themselves treated as a commercial for-profit activity requiring permission.
Commercial licensing contact: **relakkes@gmail.com**. Portions owned by third-party rights holders may also require separate permission from them.

## Redistributions must prominently state the source

Code and modified versions governed by the new license must include the complete LICENSE, copyright, and third-party license notices, and display:

```text
Based on cc-haha: https://github.com/NanmiCoder/cc-haha
Copyright (c) 2026 cc-haha
```

- Source distributions: near the beginning of the main README.
- Graphical applications: on a normally accessible "About" or legal information page.
- Binary distributions: in the product description or accompanying documentation, with the license files included in the package.
- CLI-only distributions: in normal help or license output.
- Remote access: provide the full notice on a normally accessible legal or license page; embedded components must clearly state the component's source in the appropriate place in the host.
- Modified versions: clearly mark them as unofficial or modified, describe material modifications, and do not imply official endorsement.

These requirements do not mean you must use the cc-haha logo, nor do they require "modifying a certain percentage of the code."
Changing the name, interface, or large amounts of code does not automatically exempt you from the commercial restrictions or attribution obligations.
This license contains no clause requiring publication of private modifications or independently written code.

## Boundaries of the transition from MIT

1. The main-branch commit before this change,
   [`755a18edb7e7519a12f5c7ee4265c9eb4f2ed508`](https://github.com/NanmiCoder/cc-haha/commit/755a18edb7e7519a12f5c7ee4265c9eb4f2ed508),
   uses MIT; if there were other MIT commits before the transition, the license actually distributed with the corresponding version governs.
2. Prior MIT grants remain in effect; code already obtained under MIT does not lose its original grant because the root LICENSE was replaced.
   The historical full text is available in the [LICENSE at the old commit](https://github.com/NanmiCoder/cc-haha/blob/755a18edb7e7519a12f5c7ee4265c9eb4f2ed508/LICENSE); the current repository no longer carries a separate historical MIT file and does not grant MIT rights to later additions.
3. The new license takes effect only to the extent the relevant rights holders are entitled to grant it. Third-party dependencies, embedded code, separately licensed files, and existing MIT contributions
   keep their applicable licenses and notices; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and notices in files and directories.
4. This change cannot retroactively require users of the earlier MIT version to add attribution to their README or UI, nor can it prevent them from compliantly using the old code commercially under MIT.
   The copyright and license retention obligations originally required by MIT still apply.
5. For new contributions, the contributor's grant must be made explicit before acceptance; modifying root files alone cannot claim copyright or relicensing rights from all contributors.

This transition adds no product code and cannot turn code already released under MIT into code usable only under the new license.
Anyone may still obtain that code from historical versions and compliantly modify, distribute, and commercialize it under MIT.
The new restrictions mainly apply to future additions released under the new license by those entitled to grant it, without any other independent grant.

This transition only updates the license text and notes in the source repository; no new installers are published.
When installers governed by the new license are distributed in the future, they must include LICENSE, NOTICE, and the license notices required for applicable third-party or separately licensed code,
and must be checked against the visible attribution requirements above; existing release packages are not automatically updated by this source change.

## Summary

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
