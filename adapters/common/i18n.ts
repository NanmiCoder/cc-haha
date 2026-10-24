/**
 * Adapter message localization.
 *
 * IM replies used to be hard-coded Chinese. Every message the bot sends now
 * goes through `t()`, with the active language resolved from
 * `ADAPTER_LANGUAGE` > `language` in `adapters.json` > Vietnamese. Chat users
 * can switch it at runtime with `/language`.
 *
 * Adding a message: add the key to `vi` (the source of truth for the type),
 * then to `zh` and `en` — TypeScript rejects a catalog that misses a key.
 */

import { saveAdapterLanguage } from './config.js'

export type AdapterLocale = 'vi' | 'zh' | 'en'

export const ADAPTER_LOCALES: readonly AdapterLocale[] = ['vi', 'zh', 'en']
export const DEFAULT_ADAPTER_LOCALE: AdapterLocale = 'vi'

const LOCALE_ALIASES: Record<string, AdapterLocale> = {
  vi: 'vi',
  vn: 'vi',
  'vi-vn': 'vi',
  vietnamese: 'vi',
  'tiếng việt': 'vi',
  zh: 'zh',
  cn: 'zh',
  chinese: 'zh',
  'zh-cn': 'zh',
  'zh-hans': 'zh',
  en: 'en',
  'en-us': 'en',
  'en-gb': 'en',
  english: 'en',
}

const vi = {
  // ---------- language command ----------
  'language.current': 'Ngôn ngữ hiện tại: {language}\n\nNgôn ngữ hỗ trợ:\n{languages}\n\nGửi /language <mã> để đổi, ví dụ: /language vi',
  'language.changed': 'Đã đổi ngôn ngữ sang {language}.',
  'language.invalid': 'Ngôn ngữ không hợp lệ: {value}. Các ngôn ngữ hỗ trợ: {languages}.',
  'language.usage': 'Cách dùng: /language <{languages}>',
  'language.name.vi': 'Tiếng Việt (vi)',
  'language.name.zh': '中文 (zh)',
  'language.name.en': 'English (en)',

  // ---------- pairing / runtime ----------
  'runtime.failed': 'Xử lý tin nhắn thất bại: {detail}',
  'pair.success': 'Ghép nối thành công! Bạn có thể bắt đầu trò chuyện ngay.\n\nGửi tin nhắn để trò chuyện với Claude, gửi /help để xem các lệnh khả dụng.',
  'pair.success.short': 'Ghép nối thành công! Bạn có thể bắt đầu trò chuyện ngay.\n\nGửi tin nhắn để trò chuyện với Claude.',
  'pair.denied': 'Chưa được cấp quyền. Hãy tạo mã ghép nối trong Claude Code Desktop rồi gửi cho tôi.',
  'pair.denied.wechat': 'Chưa được cấp quyền. Hãy hoàn tất liên kết WeChat bằng mã QR trong Claude Code Desktop, sau đó tạo mã ghép nối IM rồi gửi cho tôi.',
  'pair.denied.dingtalk': 'Chưa được cấp quyền. Hãy hoàn tất liên kết DingTalk bằng mã QR trong Claude Code Desktop, sau đó tạo mã ghép nối IM rồi gửi cho tôi.',
  'runtime.attachmentsOnly': '(người dùng đã gửi tệp đính kèm)',
  'runtime.sendFailed': 'Gửi tin nhắn thất bại, kết nối có thể đã bị ngắt. Hãy gửi /new để bắt đầu lại.',
  'runtime.stopSent': 'Đã gửi tín hiệu dừng.',
  'runtime.cleared': 'Đã xóa ngữ cảnh phiên hiện tại.',
  'runtime.clearFailed': 'Không thể gửi /clear, hãy gửi /new để kết nối lại phiên.',
  'runtime.error': 'Lỗi: {message}',
  'runtime.unauthorizedCallback': 'Chưa được cấp quyền',
  'runtime.selectionExpiredCallback': 'Lựa chọn đã hết hạn, hãy gửi lại lệnh',
  'runtime.selectionMissingCallback': 'Lựa chọn không tồn tại, hãy gửi lại lệnh',
  'runtime.processingCallback': 'Đang xử lý...',
  'common.choose': 'Chọn',

  // ---------- server / session ----------
  'server.connectTimeout': 'Kết nối máy chủ quá thời gian, hãy thử lại.',
  'session.createFailed': 'Không thể tạo phiên: {error}',
  'session.invalidReconnecting': 'Ngữ cảnh phiên đã hết hiệu lực, đang tự động tạo lại...',
  'session.rebuilt': 'Đã tạo lại phiên, hãy gửi lại tin nhắn.',
  'session.rebuildFailed': 'Tạo lại phiên thất bại, hãy gửi /new để tạo thủ công.',
  'session.invalid': 'Ngữ cảnh phiên đã hết hiệu lực, hãy gửi /new để tạo phiên mới.',
  'session.reconnectNotice': 'Tạm thời không thể kết nối phiên cũ, đã giữ phiên và thư mục làm việc, hãy thử lại sau.',
  'session.createdReady': 'Đã tạo phiên mới, bạn có thể bắt đầu trò chuyện.',
  'session.createdNamed': 'Đã tạo phiên mới: {name}{branch}',

  // ---------- projects ----------
  'project.noneRecent': 'Không tìm thấy dự án gần đây. Gửi /new sẽ dùng thư mục làm việc mặc định: {workDir}\nBạn cũng có thể gửi /new /path/to/project để chỉ định dự án.',
  'project.pickerTitle': 'Chọn dự án (trả lời bằng số):\n\n{list}\n\nLần sau bạn có thể dùng /new <số, tên hoặc đường dẫn tuyệt đối> để tạo phiên nhanh.',
  'project.listFailed': 'Không thể lấy danh sách dự án: {error}',
  'project.ambiguous': 'Tìm thấy nhiều dự án, hãy chỉ định rõ hơn:\n\n{list}',
  'project.ambiguousOutcome': 'Tìm thấy nhiều dự án, hãy gửi /new <tên hoặc đường dẫn đầy đủ hơn> để chọn:\n\n{choices}',
  'project.notFound': 'Không tìm thấy dự án khớp với "{query}". Gửi /projects để xem danh sách đầy đủ.',
  'project.createdNamed': '✅ Đã tạo phiên mới: **{name}**{branch}',
  'project.createdReady': '✅ Đã tạo phiên mới, bạn có thể bắt đầu trò chuyện.',
  'project.outcomeError': '❌ {message}',

  // ---------- attachments ----------
  'attachment.tooLargeImage': '📎 Ảnh quá lớn ({size} MB), vui lòng giữ dưới {limit} MB',
  'attachment.unsupportedImage': '📎 Định dạng ảnh không được hỗ trợ ({mime})',
  'attachment.fileTooLarge': '📎 Tệp quá lớn ({size} MB), vui lòng giữ dưới {limit} MB',
  'attachment.downloadFailed': '📎 Tải tệp đính kèm thất bại, hãy thử lại sau.',
  'attachment.downloadPartial': '📎 {count} tệp đính kèm tải thất bại, đã bỏ qua.',
  'attachment.processFailed': '📎 Xử lý tệp đính kèm gặp lỗi, hãy thử lại sau.',
  'attachment.authorizationFailed': '📎 Cấp quyền tải tệp đính kèm thất bại, hãy thử lại sau.',

  // ---------- help ----------
  'help.header': 'Các lệnh khả dụng:',
  'help.new': '/new [dự án] / tạo phiên — Tạo phiên mới hoặc chuyển dự án',
  'help.projects': '/projects / danh sách dự án — Xem các dự án gần đây',
  'help.sessions': '/sessions [dự án] / danh sách phiên — Xem các phiên cũ của dự án hiện tại',
  'help.sessionsProjects': '/sessions projects — Chọn phiên cũ của dự án khác',
  'help.resume': '/resume <số> / tiếp tục <số> — Khôi phục phiên trong danh sách',
  'help.paging': '/sessions next / /sessions prev — Chuyển trang',
  'help.cancel': '/cancel / hủy chọn — Thoát lựa chọn, giữ phiên hiện tại',
  'help.status': '/status / trạng thái — Xem trạng thái phiên hiện tại',
  'help.clear': '/clear / xóa — Xóa ngữ cảnh phiên hiện tại',
  'help.stop': '/stop / dừng — Dừng lượt tạo hiện tại',
  'help.help': '/help / trợ giúp — Hiển thị trợ giúp này',
  'help.language': '/language / ngôn ngữ — Đổi ngôn ngữ trả lời của bot',
  'help.permission': 'Phê duyệt quyền: /allow <id>, /always <id>, /deny <id>',

  // ---------- status ----------
  'status.noSession': 'Hiện không có phiên hoạt động.\n\nGửi /sessions để chọn phiên cũ, /new để tạo phiên mới, hoặc /projects để chọn dự án.',
  'status.title': 'Trạng thái phiên hiện tại:',
  'status.project': 'Dự án: {name}',
  'status.branch': 'Nhánh: {branch}',
  'status.session': 'Phiên: {id}',
  'status.model': 'Mô hình: {model}',
  'status.state': 'Trạng thái: {state}',
  'status.approvals': 'Phê duyệt: {count} đang chờ',
  'status.tasks': 'Tác vụ: {parts}',
  'status.taskTotal': 'Tổng {count}',
  'status.taskInProgress': 'Đang chạy {count}',
  'status.taskPending': 'Chờ xử lý {count}',
  'status.taskCompleted': 'Đã xong {count}',
  'state.thinking': 'Đang suy nghĩ',
  'state.streaming': 'Đang tạo',
  'state.toolExecuting': 'Đang chạy công cụ',
  'state.permissionPending': 'Chờ phê duyệt quyền',
  'state.idle': 'Rảnh',
  'thinking.indicator': 'Đang suy nghĩ...',
  'thinking.reasoning': '💭 **Đang suy nghĩ**',

  // ---------- permissions ----------
  'permission.requestMissing': 'Không tìm thấy yêu cầu cấp quyền đang chờ: {requestId}',
  'permission.responseFailed': 'Gửi phản hồi cấp quyền thất bại, hãy kiểm tra trạng thái phiên.',
  'permission.request': '🔐 Cần xác nhận quyền [{requestId}]\nCông cụ: {tool}\n{preview}',
  'permission.instructions': 'Trả lời 1 để cho phép một lần, 2 để cho phép vĩnh viễn, 3 để từ chối.\nBạn cũng có thể trả lời /allow {requestId}, /always {requestId}, /deny {requestId}.',
  'permission.decision.denied': '❌ Đã từ chối',
  'permission.decision.allowed': '✅ Đã cho phép',
  'permission.decision.always': '♾️ Đã cho phép vĩnh viễn',
  'permission.button.allow': '✅ Cho phép',
  'permission.button.always': '♾️ Cho phép vĩnh viễn',
  'permission.button.deny': '❌ Từ chối',
  'permission.button.allowPlain': 'Cho phép một lần',
  'permission.button.alwaysPlain': 'Cho phép vĩnh viễn',
  'permission.button.denyPlain': 'Từ chối',
  'permission.expired': 'Yêu cầu cấp quyền đã hết hiệu lực',
  'permission.sendFailed': 'Gửi phản hồi cấp quyền thất bại',
  'permission.toast.always': '♾️ Đã cho phép vĩnh viễn (không hỏi lại thao tác tương tự trong phiên này)',
  'permission.toast.allowed': '✅ Đã cho phép',
  'permission.toast.denied': '❌ Đã từ chối',

  // ---------- session selection ----------
  'selection.busyPermission': 'Phiên hiện tại đang chạy hoặc chờ phê duyệt. Hãy xử lý phê duyệt hoặc gửi /stop, đợi dừng rồi mới chuyển.',
  'selection.gone': 'Phiên này không còn tồn tại, thư mục không khả dụng hoặc không được phép truy cập qua IM. Gửi /sessions để làm mới danh sách.',
  'selection.checkFailed': 'Không thể kiểm tra phiên, liên kết hiện tại chưa thay đổi: {error}. Hãy thử lại.',
  'selection.busy': 'Phiên hiện tại đang chạy, hãy gửi /stop và đợi dừng rồi mới chuyển.',
  'selection.restoreFailed': 'Khôi phục thất bại, đã giữ liên kết phiên cũ: {error}. Hãy thử lại.',
  'selection.restored': 'Đã khôi phục phiên: {title}\n{workDir}\nID phiên: {id}\nBạn có thể tiếp tục gửi tin nhắn.',
  'selection.cancelled': 'Đã hủy chọn, phiên hiện tại không thay đổi.',
  'selection.restoreError': 'Không thể khôi phục phiên: {error}. Hãy thử lại /sessions.',
  'selection.expired': 'Danh sách chọn không tồn tại hoặc đã hết hạn, hãy gửi /sessions để chọn lại.',
  'selection.projectNotFound': 'Không tìm thấy dự án "{query}". Gửi /sessions projects để chọn dự án, hoặc /sessions <đường dẫn tuyệt đối>.',
  'selection.noProjects': 'Không có dự án lịch sử nào có thể truy cập. Gửi /new để tạo phiên mới, hoặc /sessions <đường dẫn tuyệt đối> để tìm phiên cũ.',
  'selection.projectNoSessions': 'Dự án này không có phiên nào có thể khôi phục: {project}\nGửi /sessions projects để chọn dự án khác, hoặc /new <dự án> để tạo phiên mới.',
  'selection.invalidNumber': 'Số không hợp lệ, hãy dùng số hiển thị trên trang hiện tại, hoặc gửi /sessions để làm mới danh sách.',
  'selection.untitled': 'Phiên chưa đặt tên',
  'selection.current': ' (hiện tại)',
  'selection.messageCount': '{count} tin nhắn',
  'selection.pickerProjects': 'Chọn dự án chứa phiên lịch sử:',
  'selection.pickerSessions': 'Phiên lịch sử: {project}',
  'selection.page': 'Trang {page}/{total}',
  'selection.projectsHint': 'Trả lời bằng số để xem phiên.',
  'selection.sessionsHint': 'Trả lời bằng số hoặc /resume <số> để tiếp tục phiên cũ.',
  'selection.paging': 'Chuyển trang: /sessions next, /sessions prev',
  'selection.footer': '/cancel để hủy; danh sách có hiệu lực trong 15 phút.',

  // ---------- telegram ----------
  'telegram.ready': '👋 Claude Code Bot đã sẵn sàng.',
  'telegram.extendedCommands': 'Lệnh mở rộng Telegram:',
  'telegram.resumeHint': '/resume — chọn dự án và phiên lịch sử bằng nút bấm',
  'telegram.providerHint': '/provider — chuyển Provider',
  'telegram.modelHint': '/model [model] — xem hoặc chuyển mô hình',
  'telegram.skillsHint': '/skills — xem các Skills khả dụng của dự án hiện tại',
  'telegram.cmd.start': 'Bắt đầu',
  'telegram.cmd.help': 'Xem trợ giúp',
  'telegram.cmd.new': 'Tạo phiên mới hoặc chuyển dự án',
  'telegram.cmd.projects': 'Xem các dự án gần đây',
  'telegram.cmd.sessions': 'Xem các phiên cũ của dự án',
  'telegram.cmd.resume': 'Khôi phục phiên cũ',
  'telegram.cmd.status': 'Xem trạng thái hiện tại',
  'telegram.cmd.clear': 'Xóa ngữ cảnh hiện tại',
  'telegram.cmd.stop': 'Dừng lượt tạo hiện tại',
  'telegram.cmd.provider': 'Chuyển Provider',
  'telegram.cmd.model': 'Chuyển mô hình',
  'telegram.cmd.skills': 'Xem và gọi Skills',
  'telegram.cmd.allow': 'Cho phép yêu cầu quyền',
  'telegram.cmd.always': 'Cho phép vĩnh viễn trong phiên này',
  'telegram.cmd.deny': 'Từ chối yêu cầu quyền',
  'telegram.cmd.language': 'Đổi ngôn ngữ trả lời',
  'telegram.selectProvider': 'Chọn Provider:',
  'telegram.providerListFailed': 'Không thể lấy danh sách Provider',
  'telegram.officialProvider': 'Claude chính thức',
  'telegram.officialProviderDesc': 'Dùng Claude chính thức hoặc cấu hình biến môi trường',
  'telegram.openaiProviderDesc': 'Dùng mô hình Codex đăng nhập qua ChatGPT',
  'telegram.defaultModel': 'Mô hình mặc định: {model}',
  'telegram.providerSwitchFailed': '❌ Chuyển Provider thất bại: {error}',
  'telegram.newConfigHint': 'Gửi /new để áp dụng cấu hình mới cho phiên mới.',
  'telegram.runtimeHint': 'Phiên đang chạy có thể vẫn dùng runtime cũ; gửi /new để khởi động theo cấu hình mới.',
  'telegram.providerChanged': '✅ Đã chuyển Provider: {label}',
  'telegram.selectModel': 'Chọn mô hình ({provider}):',
  'telegram.noModels': 'Không có mô hình khả dụng. Hãy cấu hình Provider trong ứng dụng desktop trước.',
  'telegram.modelListFailed': 'Không thể lấy danh sách mô hình',
  'telegram.modelSwitchFailed': '❌ Chuyển mô hình thất bại: {error}',
  'telegram.modelChanged': '✅ Đã chuyển mô hình: {model}',
  'telegram.chooseProjectFirst': 'Hãy gửi /new để chọn dự án trước khi xem Skills.',
  'telegram.noSkills': 'Dự án hiện tại không có Skills khả dụng: {cwd}',
  'telegram.skillsTitle': 'Skills khả dụng của dự án hiện tại:\n{cwd}',
  'telegram.skillsListFailed': 'Không thể lấy Skills',
  'telegram.sessionGoneSkills': '⚠️ Phiên đã hết hiệu lực, hãy gửi /new để chọn lại dự án rồi gọi Skill.',
  'telegram.skillSendFailed': '⚠️ Gửi Skill thất bại. {notice}',
  'telegram.skillInvoked': '✅ Đã gọi Skill: {label}',
  'telegram.skillSent': 'Tác vụ đã được gửi tới Agent hiện tại, sẽ tiếp tục dùng ngữ cảnh, công cụ và quyền của phiên này.',
  'telegram.resumeNoProjects': 'Không tìm thấy dự án gần đây. Hãy gửi /new để tạo phiên.',
  'telegram.resumeProjectTitle': 'Chọn dự án cần khôi phục:',
  'telegram.projectSessionCount': '{path} · {count} phiên',
  'telegram.projectListFailed': 'Không thể lấy danh sách dự án',
  'telegram.noSessionsToRestore': 'Không có phiên nào có thể khôi phục: {project}',
  'telegram.resumeSessionTitle': 'Chọn phiên cần khôi phục:\n{project}',
  'telegram.sessionListFailed': '❌ Không thể lấy danh sách phiên: {error}',
  'telegram.sessionMissingWorkDir': '❌ Phiên này thiếu thư mục làm việc, không thể khôi phục.',
  'telegram.sessionLabel': 'Phiên {id}',
  'telegram.selectionPage': 'Trang {page}/{total}',
  'telegram.prev': 'Trước',
  'telegram.next': 'Sau',
  'telegram.permissionExpired': 'Yêu cầu cấp quyền đã hết hiệu lực',
  'telegram.permissionSendFailed': 'Gửi phản hồi cấp quyền thất bại',

  // ---------- feishu ----------
  'feishu.projectCount': 'Tổng {total} dự án gần đây, hiển thị {shown}',
  'feishu.projectCountShort': 'Tổng {total} dự án gần đây',
  'feishu.choose': 'Chọn',
  'feishu.projectCardTitle': '📁 Chọn dự án',
  'feishu.projectCardHint': '💡 Nhấn nút **Chọn** bên phải, hoặc gửi `/new <tên dự án>`',
  'feishu.tool.writeFile': 'Ghi tệp',
  'feishu.tool.editFile': 'Sửa tệp',
  'feishu.tool.readFile': 'Đọc tệp',
  'feishu.tool.runCommand': 'Chạy lệnh',
  'feishu.tool.searchContent': 'Tìm nội dung',
  'feishu.tool.findFiles': 'Tìm tệp',
  'feishu.tool.visitWeb': 'Truy cập trang web',
  'feishu.tool.searchWeb': 'Tìm kiếm web',
  'feishu.crossDirWarning': '⚠️ **Thao tác này nằm ngoài thư mục dự án hiện tại**',
  'feishu.crossDirShort': '⚠️ Thao tác ngoài thư mục',
  'feishu.permissionTitle': '🔐 Cần xác nhận quyền',
  'feishu.errorCardTitle': '❌ Đã xảy ra lỗi',
  'feishu.unknownError': 'Lỗi không xác định',
  'feishu.thinking': '☁️ *Đang suy nghĩ...*',
  'feishu.sessionCreatedNamed': '✅ Đã tạo phiên mới: **{name}**',
  'feishu.attachmentProcessFailed': '📎 Xử lý tệp đính kèm gặp lỗi, hãy thử lại sau.',

  // ---------- wechat ----------
  'wechat.quote': '[Trích dẫn: {parts}]',
  'wechat.qrReady': 'Mã QR đã sẵn sàng, hãy dùng WeChat để quét.',
  'wechat.qrInstruction': 'Dùng WeChat quét mã QR để hoàn tất liên kết.',
  'wechat.noBinding': 'Hiện không có liên kết WeChat nào đang diễn ra, hãy tạo lại mã QR.',
  'wechat.waiting': 'Đang chờ quét mã.',
  'wechat.scanned': 'Đã quét, hãy xác nhận trong WeChat.',
  'wechat.scannedRedirect': 'Đã quét, đang chuyển cổng WeChat.',
  'wechat.expired': 'Mã QR đã hết hạn, hãy tạo lại.',
  'wechat.incomplete': 'WeChat đã xác nhận nhưng máy chủ không trả về đủ thông tin xác thực.',
  'wechat.bound': 'Liên kết WeChat thành công.',
  'whatsapp.ready': 'Claude Code WhatsApp đã sẵn sàng.',

  // ---------- wecom ----------
  'wecom.qrReady': 'Mã QR đã sẵn sàng, hãy dùng WeCom để quét.',
  'wecom.qrInstruction': 'Dùng WeCom quét mã QR để tạo và cấp quyền cho bot thông minh.',
  'wecom.noBinding': 'Hiện không có liên kết WeCom nào đang diễn ra, hãy tạo lại mã QR.',
  'wecom.incomplete': 'WeCom trả về thông tin xác thực bot không đầy đủ, hãy quét lại.',
  'wecom.expired': 'Mã QR đã hết hạn, hãy tạo lại.',
  'wecom.failed': 'Cấp quyền WeCom thất bại, hãy quét lại.',
  'wecom.waiting': 'Đang chờ xác nhận quét mã WeCom...',

  // ---------- qq ----------
  'qq.incomplete': 'Thông tin xác thực bot do QQ trả về không đầy đủ, hãy quét lại.',
  'qq.failed': 'Cấp quyền quét mã QQ thất bại.',
  'qq.qrTimeout': 'Lấy mã QR QQ quá thời gian, hãy thử lại.',
  'qq.qrInstruction': 'Dùng QQ quét mã QR để tạo và cấp quyền cho bot.',
  'qq.noBinding': 'Hiện không có liên kết QQ nào đang diễn ra, hãy tạo lại mã QR.',
  'qq.expired': 'Mã QR đã hết hạn, hãy tạo lại.',
  'qq.failedRescan': 'Cấp quyền QQ thất bại, hãy quét lại.',
  'qq.waiting': 'Đang chờ xác nhận quét mã QQ...',

  // ---------- feishu app registration ----------
  'feishu.qrInstruction': 'Dùng Feishu quét mã QR, bot sẽ được tạo tự động sau khi xác nhận.',
  'feishu.noBinding': 'Hiện không có lượt quét Feishu nào đang diễn ra, hãy tạo lại mã QR.',
  'feishu.waiting': 'Đang chờ xác nhận quét mã Feishu...',
  'feishu.expired': 'Mã QR đã hết hạn, hãy tạo lại.',
  'feishu.denied': 'Cấp quyền Feishu bị từ chối.',
  'feishu.failed': 'Cấp quyền quét mã Feishu thất bại, hãy thử lại.',

  // ---------- dingtalk ----------
  'dingtalk.permissionCardTitle': 'Claude Code cần xác nhận quyền',
  'dingtalk.permissionSent': '{requestText}\n\nĐã gửi thẻ quyền DingTalk; nếu không thấy thẻ, bạn cũng có thể {instructions}',
} as const

export type MessageKey = keyof typeof vi

/** Every catalog key, for coverage tests that must visit the whole surface. */
export const MESSAGE_KEYS = Object.keys(vi) as MessageKey[]

const zh: Record<MessageKey, string> = {
  'language.current': '当前语言：{language}\n\n支持的语言：\n{languages}\n\n发送 /language <代码> 切换，例如：/language vi',
  'language.changed': '已切换语言为 {language}。',
  'language.invalid': '不支持的语言：{value}。支持的语言：{languages}。',
  'language.usage': '用法：/language <{languages}>',
  'language.name.vi': 'Tiếng Việt (vi)',
  'language.name.zh': '中文 (zh)',
  'language.name.en': 'English (en)',

  'runtime.failed': '处理消息失败：{detail}',
  'pair.success': '配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话，发送 /help 查看可用命令。',
  'pair.success.short': '配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。',
  'pair.denied': '未授权。请在 Claude Code 桌面端生成配对码后发送给我。',
  'pair.denied.wechat': '未授权。请先在 Claude Code 桌面端完成微信扫码绑定，再生成 IM 配对码后发送给我。',
  'pair.denied.dingtalk': '未授权。请先在 Claude Code 桌面端完成钉钉扫码绑定，再生成 IM 配对码后发送给我。',
  'runtime.attachmentsOnly': '(用户发送了附件)',
  'runtime.sendFailed': '消息发送失败，连接可能已断开。请发送 /new 重新开始。',
  'runtime.stopSent': '已发送停止信号。',
  'runtime.cleared': '已清空当前会话上下文。',
  'runtime.clearFailed': '无法发送 /clear，请先发送 /new 重新连接会话。',
  'runtime.error': '错误: {message}',
  'runtime.unauthorizedCallback': '未授权',
  'runtime.selectionExpiredCallback': '选择已过期，请重新发送命令',
  'runtime.selectionMissingCallback': '选项不存在，请重新发送命令',
  'runtime.processingCallback': '处理中...',
  'common.choose': '选择',

  'server.connectTimeout': '连接服务器超时，请重试。',
  'session.createFailed': '无法创建会话: {error}',
  'session.invalidReconnecting': '会话上下文已失效，正在自动重建...',
  'session.rebuilt': '已重建会话，请重新发送消息。',
  'session.rebuildFailed': '重建会话失败，请发送 /new 手动新建。',
  'session.invalid': '会话上下文已失效，请发送 /new 新建会话。',
  'session.reconnectNotice': '暂时无法连接原会话，已保留会话和工作目录，请稍后重试。',
  'session.createdReady': '已新建会话，可以开始对话了。',
  'session.createdNamed': '已新建会话：{name}{branch}',

  'project.noneRecent': '没有找到最近的项目。发送 /new 会使用默认工作目录：{workDir}\n也可以发送 /new /path/to/project 指定项目。',
  'project.pickerTitle': '选择项目（回复编号）：\n\n{list}\n\n下次可直接 /new <编号、名称或绝对路径> 快速新建会话',
  'project.listFailed': '无法获取项目列表: {error}',
  'project.ambiguous': '匹配到多个项目，请更精确：\n\n{list}',
  'project.ambiguousOutcome': '匹配到多个项目，请发送 /new <更完整名称或路径> 选择：\n\n{choices}',
  'project.notFound': '未找到匹配 "{query}" 的项目。发送 /projects 查看完整列表。',
  'project.createdNamed': '✅ 已新建会话：**{name}**{branch}',
  'project.createdReady': '✅ 已新建会话，可以开始对话了。',
  'project.outcomeError': '❌ {message}',

  'attachment.tooLargeImage': '📎 图片过大({size} MB),请控制在 {limit} MB 以内',
  'attachment.unsupportedImage': '📎 暂不支持此图片格式({mime})',
  'attachment.fileTooLarge': '📎 文件过大({size} MB),请控制在 {limit} MB 以内',
  'attachment.downloadFailed': '📎 附件下载失败，请稍后重试。',
  'attachment.downloadPartial': '📎 {count} 个附件下载失败，已跳过。',
  'attachment.processFailed': '📎 附件处理异常，请稍后重试',
  'attachment.authorizationFailed': '📎 附件下载授权失败，请稍后重试。',

  'help.header': '可用命令：',
  'help.new': '/new [项目] / 新会话 — 新建会话或切换项目',
  'help.projects': '/projects / 项目列表 — 查看最近项目',
  'help.sessions': '/sessions [项目] / 会话列表 — 查看当前项目的旧会话',
  'help.sessionsProjects': '/sessions projects — 选择其他项目的旧会话',
  'help.resume': '/resume <编号> / 继续会话 <编号> — 恢复列表中的会话',
  'help.paging': '/sessions next / /sessions prev — 翻页',
  'help.cancel': '/cancel / 取消选择 — 退出选择，保留当前会话',
  'help.status': '/status / 状态 — 查看当前会话状态',
  'help.clear': '/clear / 清空 — 清空当前会话上下文',
  'help.stop': '/stop / 停止 — 停止当前生成',
  'help.help': '/help / 帮助 — 显示这份帮助',
  'help.language': '/language / 语言 — 切换机器人回复语言',
  'help.permission': '权限审批：/allow <id>、/always <id>、/deny <id>',

  'status.noSession': '当前没有活动会话。\n\n发送 /sessions 选择旧会话，/new 新建会话，或 /projects 选择项目。',
  'status.title': '当前会话状态：',
  'status.project': '项目: {name}',
  'status.branch': '分支: {branch}',
  'status.session': '会话: {id}',
  'status.model': '模型: {model}',
  'status.state': '状态: {state}',
  'status.approvals': '审批: {count} 个待确认',
  'status.tasks': '任务: {parts}',
  'status.taskTotal': '总计 {count}',
  'status.taskInProgress': '进行中 {count}',
  'status.taskPending': '待处理 {count}',
  'status.taskCompleted': '已完成 {count}',
  'state.thinking': '思考中',
  'state.streaming': '生成中',
  'state.toolExecuting': '执行工具中',
  'state.permissionPending': '等待权限确认',
  'state.idle': '空闲',
  'thinking.indicator': '思考中...',
  'thinking.reasoning': '💭 **思考中**',

  'permission.requestMissing': '未找到待确认的权限请求：{requestId}',
  'permission.responseFailed': '权限响应发送失败，请检查会话状态。',
  'permission.request': '🔐 需要权限确认 [{requestId}]\n工具: {tool}\n{preview}',
  'permission.instructions': '回复 1 允许一次，2 永久允许，3 拒绝。\n也可回复 /allow {requestId}、/always {requestId}、/deny {requestId}。',
  'permission.decision.denied': '❌ 已拒绝',
  'permission.decision.allowed': '✅ 已允许',
  'permission.decision.always': '♾️ 已永久允许',
  'permission.button.allow': '✅ 允许',
  'permission.button.always': '♾️ 永久允许',
  'permission.button.deny': '❌ 拒绝',
  'permission.button.allowPlain': '允许一次',
  'permission.button.alwaysPlain': '永久允许',
  'permission.button.denyPlain': '拒绝',
  'permission.expired': '权限请求已失效',
  'permission.sendFailed': '权限响应发送失败',
  'permission.toast.always': '♾️ 已永久允许（本次会话内不再询问相同操作）',
  'permission.toast.allowed': '✅ 已允许',
  'permission.toast.denied': '❌ 已拒绝',

  'selection.busyPermission': '当前会话正在运行或等待审批，请先处理审批或发送 /stop，等停止后再切换。',
  'selection.gone': '该会话已不存在、目录不可用或不允许通过 IM 访问。请发送 /sessions 刷新列表。',
  'selection.checkFailed': '无法检查会话，当前绑定未改变：{error}。请重试。',
  'selection.busy': '当前会话正在运行，请先发送 /stop，等停止后再切换。',
  'selection.restoreFailed': '恢复失败，已保留原会话绑定：{error}。请重试。',
  'selection.restored': '已恢复会话：{title}\n{workDir}\n会话 ID：{id}\n可以继续发送消息。',
  'selection.cancelled': '已取消选择，当前会话未改变。',
  'selection.restoreError': '无法恢复会话：{error}。请重试 /sessions。',
  'selection.expired': '选择列表不存在或已过期，请发送 /sessions 重新选择。',
  'selection.projectNotFound': '未找到项目“{query}”。发送 /sessions projects 选择项目，或 /sessions <绝对路径>。',
  'selection.noProjects': '没有可访问的历史项目。发送 /new 新建会话，或 /sessions <项目绝对路径> 查找旧会话。',
  'selection.projectNoSessions': '该项目没有可恢复会话：{project}\n发送 /sessions projects 选择其他项目，或 /new <项目> 新建会话。',
  'selection.invalidNumber': '编号无效，请使用当前页显示的编号，或发送 /sessions 刷新列表。',
  'selection.untitled': '未命名会话',
  'selection.current': '（当前）',
  'selection.messageCount': '{count} 条消息',
  'selection.pickerProjects': '选择历史会话所在的项目：',
  'selection.pickerSessions': '历史会话：{project}',
  'selection.page': '第 {page}/{total} 页',
  'selection.projectsHint': '回复编号查看会话。',
  'selection.sessionsHint': '回复编号或 /resume <编号> 继续旧会话。',
  'selection.paging': '翻页：/sessions next、/sessions prev',
  'selection.footer': '/cancel 取消；列表 15 分钟内有效。',

  'telegram.ready': '👋 Claude Code Bot 已就绪。',
  'telegram.extendedCommands': 'Telegram 扩展命令：',
  'telegram.resumeHint': '/resume — 按钮选择项目与历史会话',
  'telegram.providerHint': '/provider — 切换 Provider',
  'telegram.modelHint': '/model [model] — 查看或切换模型',
  'telegram.skillsHint': '/skills — 查看当前项目可用 Skills',
  'telegram.cmd.start': '开始使用',
  'telegram.cmd.help': '查看帮助',
  'telegram.cmd.new': '新建会话或切换项目',
  'telegram.cmd.projects': '查看最近项目',
  'telegram.cmd.sessions': '查看项目历史会话',
  'telegram.cmd.resume': '恢复历史会话',
  'telegram.cmd.status': '查看当前状态',
  'telegram.cmd.clear': '清空当前上下文',
  'telegram.cmd.stop': '停止当前生成',
  'telegram.cmd.provider': '切换 Provider',
  'telegram.cmd.model': '切换模型',
  'telegram.cmd.skills': '查看并调用 Skills',
  'telegram.cmd.allow': '允许权限请求',
  'telegram.cmd.always': '本会话永久允许',
  'telegram.cmd.deny': '拒绝权限请求',
  'telegram.cmd.language': '切换回复语言',
  'telegram.selectProvider': '选择 Provider：',
  'telegram.providerListFailed': '无法获取 Provider 列表',
  'telegram.officialProvider': 'Claude 官方',
  'telegram.officialProviderDesc': '使用 Claude 官方或环境变量配置',
  'telegram.openaiProviderDesc': '使用 ChatGPT 登录的 Codex 模型',
  'telegram.defaultModel': '默认模型：{model}',
  'telegram.providerSwitchFailed': '❌ Provider 切换失败：{error}',
  'telegram.newConfigHint': '发送 /new 后新配置会用于新会话。',
  'telegram.runtimeHint': '当前已运行的会话可能仍使用旧 runtime；发送 /new 后会按新配置启动。',
  'telegram.providerChanged': '✅ 已切换 Provider：{label}',
  'telegram.selectModel': '选择模型（{provider}）：',
  'telegram.noModels': '没有可用模型。请先在桌面端配置 Provider。',
  'telegram.modelListFailed': '无法获取模型列表',
  'telegram.modelSwitchFailed': '❌ 模型切换失败：{error}',
  'telegram.modelChanged': '✅ 已切换模型：{model}',
  'telegram.chooseProjectFirst': '请先发送 /new 选择项目，再查看 Skills。',
  'telegram.noSkills': '当前项目没有可用 Skills：{cwd}',
  'telegram.skillsTitle': '当前项目可用 Skills：\n{cwd}',
  'telegram.skillsListFailed': '无法获取 Skills',
  'telegram.sessionGoneSkills': '⚠️ 会话已失效，请发送 /new 重新选择项目后再调用 Skill。',
  'telegram.skillSendFailed': '⚠️ Skill 发送失败。{notice}',
  'telegram.skillInvoked': '✅ 已调用 Skill：{label}',
  'telegram.skillSent': '任务已发送给当前 Agent，会继续使用这条会话的上下文、工具和权限设置。',
  'telegram.resumeNoProjects': '没有找到最近项目。请先发送 /new 创建会话。',
  'telegram.resumeProjectTitle': '选择要恢复的项目：',
  'telegram.projectSessionCount': '{path} · {count} 个会话',
  'telegram.projectListFailed': '无法获取项目列表',
  'telegram.noSessionsToRestore': '没有可恢复会话：{project}',
  'telegram.resumeSessionTitle': '选择要恢复的会话：\n{project}',
  'telegram.sessionListFailed': '❌ 无法获取会话列表：{error}',
  'telegram.sessionMissingWorkDir': '❌ 这个会话缺少工作目录，无法恢复。',
  'telegram.sessionLabel': '会话 {id}',
  'telegram.selectionPage': '第 {page}/{total} 页',
  'telegram.prev': '上一页',
  'telegram.next': '下一页',
  'telegram.permissionExpired': '权限请求已失效',
  'telegram.permissionSendFailed': '权限响应发送失败',

  'feishu.projectCount': '共 {total} 个最近项目，显示前 {shown}',
  'feishu.projectCountShort': '共 {total} 个最近项目',
  'feishu.choose': '选择',
  'feishu.projectCardTitle': '📁 选择项目',
  'feishu.projectCardHint': '💡 点击右侧 **选择** 按钮，或发送 `/new <项目名>`',
  'feishu.tool.writeFile': '写入文件',
  'feishu.tool.editFile': '修改文件',
  'feishu.tool.readFile': '读取文件',
  'feishu.tool.runCommand': '执行命令',
  'feishu.tool.searchContent': '搜索内容',
  'feishu.tool.findFiles': '查找文件',
  'feishu.tool.visitWeb': '访问网页',
  'feishu.tool.searchWeb': '搜索网页',
  'feishu.crossDirWarning': '⚠️ **该操作位于当前项目目录之外**',
  'feishu.crossDirShort': '⚠️ 跨目录操作',
  'feishu.permissionTitle': '🔐 需要权限确认',
  'feishu.errorCardTitle': '❌ 出错了',
  'feishu.unknownError': '未知错误',
  'feishu.thinking': '☁️ *正在思考中...*',
  'feishu.sessionCreatedNamed': '✅ 已新建会话：**{name}**',
  'feishu.attachmentProcessFailed': '📎 附件处理异常,请稍后重试',

  'wechat.quote': '[引用: {parts}]',
  'wechat.qrReady': '二维码已就绪，请使用微信扫描。',
  'wechat.qrInstruction': '使用微信扫描二维码完成绑定。',
  'wechat.noBinding': '当前没有进行中的微信绑定，请重新生成二维码。',
  'wechat.waiting': '等待扫码。',
  'wechat.scanned': '已扫码，请在微信中确认。',
  'wechat.scannedRedirect': '已扫码，正在切换微信网关。',
  'wechat.expired': '二维码已过期，请重新生成。',
  'wechat.incomplete': '微信已确认，但服务端未返回完整凭据。',
  'wechat.bound': '微信绑定成功。',
  'whatsapp.ready': 'Claude Code WhatsApp 已就绪。',

  'wecom.qrReady': '二维码已就绪，请使用企业微信扫描。',
  'wecom.qrInstruction': '使用企业微信扫描二维码，创建并授权智能机器人。',
  'wecom.noBinding': '当前没有进行中的企业微信绑定，请重新生成二维码。',
  'wecom.incomplete': '企业微信返回的机器人凭据不完整，请重新扫码。',
  'wecom.expired': '二维码已过期，请重新生成。',
  'wecom.failed': '企业微信授权失败，请重新扫码。',
  'wecom.waiting': '等待企业微信扫码确认...',

  'qq.incomplete': 'QQ 返回的机器人凭据不完整，请重新扫码。',
  'qq.failed': 'QQ 扫码授权失败。',
  'qq.qrTimeout': 'QQ 二维码获取超时，请重试。',
  'qq.qrInstruction': '使用 QQ 扫描二维码，创建并授权机器人。',
  'qq.noBinding': '当前没有进行中的 QQ 绑定，请重新生成二维码。',
  'qq.expired': '二维码已过期，请重新生成。',
  'qq.failedRescan': 'QQ 授权失败，请重新扫码。',
  'qq.waiting': '等待 QQ 扫码确认...',

  'feishu.qrInstruction': '使用飞书扫描二维码，确认后会自动创建机器人。',
  'feishu.noBinding': '当前没有进行中的飞书扫码，请重新生成二维码。',
  'feishu.waiting': '等待飞书扫码确认...',
  'feishu.expired': '二维码已过期，请重新生成。',
  'feishu.denied': '飞书授权被拒绝。',
  'feishu.failed': '飞书扫码授权失败，请重试。',

  'dingtalk.permissionCardTitle': 'Claude Code 需要权限确认',
  'dingtalk.permissionSent': '{requestText}\n\n已发送钉钉权限卡片；如果卡片不可见，也可以{instructions}',
}

const en: Record<MessageKey, string> = {
  'language.current': 'Current language: {language}\n\nSupported languages:\n{languages}\n\nSend /language <code> to change, e.g. /language vi',
  'language.changed': 'Language changed to {language}.',
  'language.invalid': 'Unsupported language: {value}. Supported languages: {languages}.',
  'language.usage': 'Usage: /language <{languages}>',
  'language.name.vi': 'Tiếng Việt (vi)',
  'language.name.zh': '中文 (zh)',
  'language.name.en': 'English (en)',

  'runtime.failed': 'Failed to handle message: {detail}',
  'pair.success': 'Paired successfully! You can start chatting now.\n\nSend a message to talk to Claude, or /help to see available commands.',
  'pair.success.short': 'Paired successfully! You can start chatting now.\n\nSend a message to talk to Claude.',
  'pair.denied': 'Unauthorized. Generate a pairing code in Claude Code Desktop and send it to me.',
  'pair.denied.wechat': 'Unauthorized. Complete the WeChat QR binding in Claude Code Desktop first, then generate an IM pairing code and send it to me.',
  'pair.denied.dingtalk': 'Unauthorized. Complete the DingTalk QR binding in Claude Code Desktop first, then generate an IM pairing code and send it to me.',
  'runtime.attachmentsOnly': '(user sent attachments)',
  'runtime.sendFailed': 'Failed to send the message; the connection may have dropped. Send /new to start again.',
  'runtime.stopSent': 'Stop signal sent.',
  'runtime.cleared': 'Cleared the current session context.',
  'runtime.clearFailed': 'Could not send /clear; send /new to reconnect the session.',
  'runtime.error': 'Error: {message}',
  'runtime.unauthorizedCallback': 'Unauthorized',
  'runtime.selectionExpiredCallback': 'This selection expired; send the command again',
  'runtime.selectionMissingCallback': 'That option no longer exists; send the command again',
  'runtime.processingCallback': 'Processing...',
  'common.choose': 'Choose',

  'server.connectTimeout': 'Timed out connecting to the server. Please retry.',
  'session.createFailed': 'Could not create a session: {error}',
  'session.invalidReconnecting': 'The session context expired; rebuilding automatically...',
  'session.rebuilt': 'Session rebuilt. Please resend your message.',
  'session.rebuildFailed': 'Could not rebuild the session. Send /new to create one manually.',
  'session.invalid': 'The session context expired. Send /new to create a new session.',
  'session.reconnectNotice': 'The original session is temporarily unreachable. The session and working directory were kept; please retry later.',
  'session.createdReady': 'New session created. You can start chatting.',
  'session.createdNamed': 'New session created: {name}{branch}',

  'project.noneRecent': 'No recent projects found. /new will use the default working directory: {workDir}\nYou can also send /new /path/to/project to pick a project.',
  'project.pickerTitle': 'Choose a project (reply with a number):\n\n{list}\n\nNext time use /new <number, name or absolute path> to create a session quickly.',
  'project.listFailed': 'Could not load the project list: {error}',
  'project.ambiguous': 'Multiple projects matched; please be more specific:\n\n{list}',
  'project.ambiguousOutcome': 'Multiple projects matched. Send /new <fuller name or path> to choose:\n\n{choices}',
  'project.notFound': 'No project matched "{query}". Send /projects to see the full list.',
  'project.createdNamed': '✅ New session created: **{name}**{branch}',
  'project.createdReady': '✅ New session created. You can start chatting.',
  'project.outcomeError': '❌ {message}',

  'attachment.tooLargeImage': '📎 Image is too large ({size} MB); keep it under {limit} MB',
  'attachment.unsupportedImage': '📎 Unsupported image format ({mime})',
  'attachment.fileTooLarge': '📎 File is too large ({size} MB); keep it under {limit} MB',
  'attachment.downloadFailed': '📎 Attachment download failed. Please retry later.',
  'attachment.downloadPartial': '📎 {count} attachment(s) failed to download and were skipped.',
  'attachment.processFailed': '📎 Attachment processing failed. Please retry later.',
  'attachment.authorizationFailed': '📎 Attachment download authorization failed. Please retry later.',

  'help.header': 'Available commands:',
  'help.new': '/new [project] / new session — Create a session or switch project',
  'help.projects': '/projects / project list — View recent projects',
  'help.sessions': '/sessions [project] / session list — View older sessions of the current project',
  'help.sessionsProjects': '/sessions projects — Choose older sessions from another project',
  'help.resume': '/resume <number> / resume <number> — Restore a session from the list',
  'help.paging': '/sessions next / /sessions prev — Page through the list',
  'help.cancel': '/cancel / cancel selection — Exit selection and keep the current session',
  'help.status': '/status / status — View the current session state',
  'help.clear': '/clear / clear — Clear the current session context',
  'help.stop': '/stop / stop — Stop the current generation',
  'help.help': '/help / help — Show this help',
  'help.language': '/language — Change the bot reply language',
  'help.permission': 'Permission approvals: /allow <id>, /always <id>, /deny <id>',

  'status.noSession': 'No active session.\n\nSend /sessions to choose an older session, /new for a new one, or /projects to choose a project.',
  'status.title': 'Current session:',
  'status.project': 'Project: {name}',
  'status.branch': 'Branch: {branch}',
  'status.session': 'Session: {id}',
  'status.model': 'Model: {model}',
  'status.state': 'State: {state}',
  'status.approvals': 'Approvals: {count} pending',
  'status.tasks': 'Tasks: {parts}',
  'status.taskTotal': 'total {count}',
  'status.taskInProgress': 'in progress {count}',
  'status.taskPending': 'pending {count}',
  'status.taskCompleted': 'done {count}',
  'state.thinking': 'Thinking',
  'state.streaming': 'Generating',
  'state.toolExecuting': 'Running a tool',
  'state.permissionPending': 'Waiting for permission',
  'state.idle': 'Idle',
  'thinking.indicator': 'Thinking...',
  'thinking.reasoning': '💭 **Thinking**',

  'permission.requestMissing': 'No pending permission request found: {requestId}',
  'permission.responseFailed': 'Failed to send the permission response. Please check the session state.',
  'permission.request': '🔐 Permission required [{requestId}]\nTool: {tool}\n{preview}',
  'permission.instructions': 'Reply 1 to allow once, 2 to always allow, 3 to deny.\nYou can also reply /allow {requestId}, /always {requestId}, /deny {requestId}.',
  'permission.decision.denied': '❌ Denied',
  'permission.decision.allowed': '✅ Allowed',
  'permission.decision.always': '♾️ Always allowed',
  'permission.button.allow': '✅ Allow',
  'permission.button.always': '♾️ Always allow',
  'permission.button.deny': '❌ Deny',
  'permission.button.allowPlain': 'Allow once',
  'permission.button.alwaysPlain': 'Always allow',
  'permission.button.denyPlain': 'Deny',
  'permission.expired': 'The permission request expired',
  'permission.sendFailed': 'Failed to send the permission response',
  'permission.toast.always': '♾️ Always allowed (the same action will not be asked again in this session)',
  'permission.toast.allowed': '✅ Allowed',
  'permission.toast.denied': '❌ Denied',

  'selection.busyPermission': 'The current session is running or waiting for approval. Resolve the approval or send /stop, then switch once it stops.',
  'selection.gone': 'That session no longer exists, its directory is unavailable, or IM access is not allowed. Send /sessions to refresh.',
  'selection.checkFailed': 'Could not check the session; the current binding is unchanged: {error}. Please retry.',
  'selection.busy': 'The current session is running. Send /stop and switch once it stops.',
  'selection.restoreFailed': 'Restore failed; the previous session binding was kept: {error}. Please retry.',
  'selection.restored': 'Restored session: {title}\n{workDir}\nSession ID: {id}\nYou can keep sending messages.',
  'selection.cancelled': 'Selection cancelled; the current session is unchanged.',
  'selection.restoreError': 'Could not restore the session: {error}. Retry /sessions.',
  'selection.expired': 'The selection list is missing or expired. Send /sessions to choose again.',
  'selection.projectNotFound': 'No project matched "{query}". Send /sessions projects to choose one, or /sessions <absolute path>.',
  'selection.noProjects': 'No accessible project history. Send /new to create a session, or /sessions <absolute project path> to find older sessions.',
  'selection.projectNoSessions': 'That project has no restorable sessions: {project}\nSend /sessions projects to choose another project, or /new <project> to create a session.',
  'selection.invalidNumber': 'Invalid number. Use a number shown on the current page, or send /sessions to refresh.',
  'selection.untitled': 'Untitled session',
  'selection.current': ' (current)',
  'selection.messageCount': '{count} messages',
  'selection.pickerProjects': 'Choose the project that holds the older session:',
  'selection.pickerSessions': 'Older sessions: {project}',
  'selection.page': 'Page {page}/{total}',
  'selection.projectsHint': 'Reply with a number to view sessions.',
  'selection.sessionsHint': 'Reply with a number or /resume <number> to continue an older session.',
  'selection.paging': 'Paging: /sessions next, /sessions prev',
  'selection.footer': '/cancel to cancel; the list is valid for 15 minutes.',

  'telegram.ready': '👋 Claude Code Bot is ready.',
  'telegram.extendedCommands': 'Telegram extended commands:',
  'telegram.resumeHint': '/resume — pick a project and older session with buttons',
  'telegram.providerHint': '/provider — switch Provider',
  'telegram.modelHint': '/model [model] — view or switch the model',
  'telegram.skillsHint': '/skills — view Skills available in the current project',
  'telegram.cmd.start': 'Get started',
  'telegram.cmd.help': 'View help',
  'telegram.cmd.new': 'Create a session or switch project',
  'telegram.cmd.projects': 'View recent projects',
  'telegram.cmd.sessions': 'View the project session history',
  'telegram.cmd.resume': 'Restore an older session',
  'telegram.cmd.status': 'View the current state',
  'telegram.cmd.clear': 'Clear the current context',
  'telegram.cmd.stop': 'Stop the current generation',
  'telegram.cmd.provider': 'Switch Provider',
  'telegram.cmd.model': 'Switch model',
  'telegram.cmd.skills': 'View and invoke Skills',
  'telegram.cmd.allow': 'Allow a permission request',
  'telegram.cmd.always': 'Always allow for this session',
  'telegram.cmd.deny': 'Deny a permission request',
  'telegram.cmd.language': 'Change the reply language',
  'telegram.selectProvider': 'Choose a Provider:',
  'telegram.providerListFailed': 'Could not load the Provider list',
  'telegram.officialProvider': 'Claude Official',
  'telegram.officialProviderDesc': 'Use Claude Official or the environment configuration',
  'telegram.openaiProviderDesc': 'Use Codex models signed in through ChatGPT',
  'telegram.defaultModel': 'Default model: {model}',
  'telegram.providerSwitchFailed': '❌ Provider switch failed: {error}',
  'telegram.newConfigHint': 'Send /new so new sessions use the new configuration.',
  'telegram.runtimeHint': 'Running sessions may still use the old runtime; send /new to start with the new configuration.',
  'telegram.providerChanged': '✅ Provider switched: {label}',
  'telegram.selectModel': 'Choose a model ({provider}):',
  'telegram.noModels': 'No models available. Configure a Provider in the desktop app first.',
  'telegram.modelListFailed': 'Could not load the model list',
  'telegram.modelSwitchFailed': '❌ Model switch failed: {error}',
  'telegram.modelChanged': '✅ Model switched: {model}',
  'telegram.chooseProjectFirst': 'Send /new to choose a project before viewing Skills.',
  'telegram.noSkills': 'No Skills are available in the current project: {cwd}',
  'telegram.skillsTitle': 'Skills available in the current project:\n{cwd}',
  'telegram.skillsListFailed': 'Could not load Skills',
  'telegram.sessionGoneSkills': '⚠️ The session expired. Send /new to pick the project again, then invoke the Skill.',
  'telegram.skillSendFailed': '⚠️ Failed to send the Skill. {notice}',
  'telegram.skillInvoked': '✅ Skill invoked: {label}',
  'telegram.skillSent': 'The task was sent to the current Agent; it keeps this session\'s context, tools and permissions.',
  'telegram.resumeNoProjects': 'No recent projects found. Send /new to create a session.',
  'telegram.resumeProjectTitle': 'Choose a project to restore:',
  'telegram.projectSessionCount': '{path} · {count} sessions',
  'telegram.projectListFailed': 'Could not load the project list',
  'telegram.noSessionsToRestore': 'No sessions to restore: {project}',
  'telegram.resumeSessionTitle': 'Choose a session to restore:\n{project}',
  'telegram.sessionListFailed': '❌ Could not load the session list: {error}',
  'telegram.sessionMissingWorkDir': '❌ This session has no working directory and cannot be restored.',
  'telegram.sessionLabel': 'Session {id}',
  'telegram.selectionPage': 'Page {page}/{total}',
  'telegram.prev': 'Prev',
  'telegram.next': 'Next',
  'telegram.permissionExpired': 'The permission request expired',
  'telegram.permissionSendFailed': 'Failed to send the permission response',

  'feishu.projectCount': '{total} recent projects; showing the first {shown}',
  'feishu.projectCountShort': '{total} recent projects',
  'feishu.choose': 'Choose',
  'feishu.projectCardTitle': '📁 Choose a project',
  'feishu.projectCardHint': '💡 Tap **Choose** on the right, or send `/new <project name>`',
  'feishu.tool.writeFile': 'Write file',
  'feishu.tool.editFile': 'Edit file',
  'feishu.tool.readFile': 'Read file',
  'feishu.tool.runCommand': 'Run command',
  'feishu.tool.searchContent': 'Search content',
  'feishu.tool.findFiles': 'Find files',
  'feishu.tool.visitWeb': 'Visit webpage',
  'feishu.tool.searchWeb': 'Search the web',
  'feishu.crossDirWarning': '⚠️ **This action is outside the current project directory**',
  'feishu.crossDirShort': '⚠️ Cross-directory action',
  'feishu.permissionTitle': '🔐 Permission required',
  'feishu.errorCardTitle': '❌ Something went wrong',
  'feishu.unknownError': 'Unknown error',
  'feishu.thinking': '☁️ *Thinking...*',
  'feishu.sessionCreatedNamed': '✅ New session created: **{name}**',
  'feishu.attachmentProcessFailed': '📎 Attachment processing failed, please retry later',

  'wechat.quote': '[Quote: {parts}]',
  'wechat.qrReady': 'The QR code is ready; scan it with WeChat.',
  'wechat.qrInstruction': 'Scan the QR code with WeChat to complete the binding.',
  'wechat.noBinding': 'No WeChat binding is in progress. Generate a new QR code.',
  'wechat.waiting': 'Waiting for the scan.',
  'wechat.scanned': 'Scanned; confirm in WeChat.',
  'wechat.scannedRedirect': 'Scanned; switching the WeChat gateway.',
  'wechat.expired': 'The QR code expired. Generate a new one.',
  'wechat.incomplete': 'WeChat confirmed, but the server did not return complete credentials.',
  'wechat.bound': 'WeChat bound successfully.',
  'whatsapp.ready': 'Claude Code WhatsApp is ready.',

  'wecom.qrReady': 'The QR code is ready; scan it with WeCom.',
  'wecom.qrInstruction': 'Scan the QR code with WeCom to create and authorize the bot.',
  'wecom.noBinding': 'No WeCom binding is in progress. Generate a new QR code.',
  'wecom.incomplete': 'WeCom returned incomplete bot credentials. Scan again.',
  'wecom.expired': 'The QR code expired. Generate a new one.',
  'wecom.failed': 'WeCom authorization failed. Scan again.',
  'wecom.waiting': 'Waiting for WeCom scan confirmation...',

  'qq.incomplete': 'QQ returned incomplete bot credentials. Scan again.',
  'qq.failed': 'QQ QR authorization failed.',
  'qq.qrTimeout': 'Timed out fetching the QQ QR code. Please retry.',
  'qq.qrInstruction': 'Scan the QR code with QQ to create and authorize the bot.',
  'qq.noBinding': 'No QQ binding is in progress. Generate a new QR code.',
  'qq.expired': 'The QR code expired. Generate a new one.',
  'qq.failedRescan': 'QQ authorization failed. Scan again.',
  'qq.waiting': 'Waiting for QQ scan confirmation...',

  'feishu.qrInstruction': 'Scan the QR code with Feishu; the bot will be created automatically after confirmation.',
  'feishu.noBinding': 'No Feishu scan is in progress. Generate a new QR code.',
  'feishu.waiting': 'Waiting for Feishu scan confirmation...',
  'feishu.expired': 'The QR code expired. Generate a new one.',
  'feishu.denied': 'Feishu authorization was denied.',
  'feishu.failed': 'Feishu QR authorization failed. Please retry.',

  'dingtalk.permissionCardTitle': 'Claude Code needs permission confirmation',
  'dingtalk.permissionSent': '{requestText}\n\nA DingTalk permission card was sent; if it is not visible, you can also {instructions}',
}

const catalogs: Record<AdapterLocale, Record<MessageKey, string>> = { vi, zh, en }

let currentLocale: AdapterLocale = normalizeAdapterLocale(process.env.ADAPTER_LANGUAGE) ?? DEFAULT_ADAPTER_LOCALE

export function normalizeAdapterLocale(value: unknown): AdapterLocale | null {
  if (typeof value !== 'string') return null
  return LOCALE_ALIASES[value.trim().toLowerCase()] ?? null
}

export function getAdapterLocale(): AdapterLocale {
  return currentLocale
}

/** Set the process-wide locale without touching the config file. */
export function setAdapterLocale(value: unknown): AdapterLocale {
  const locale = normalizeAdapterLocale(value)
  if (locale) currentLocale = locale
  return currentLocale
}

/** Set and persist the locale so every adapter process picks it up. */
export function setAdapterLanguage(value: unknown): AdapterLocale | null {
  const locale = normalizeAdapterLocale(value)
  if (!locale) return null
  currentLocale = locale
  saveAdapterLanguage(locale)
  return locale
}

/** BCP 47 tag for Date#toLocaleString and friends. */
export function adapterLocaleTag(locale: AdapterLocale = currentLocale): string {
  switch (locale) {
    case 'vi':
      return 'vi-VN'
    case 'zh':
      return 'zh-CN'
    case 'en':
      return 'en-US'
  }
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  let result = text
  for (const [key, value] of Object.entries(params)) {
    result = result.split(`{${key}}`).join(String(value))
  }
  return result
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return interpolate(catalogs[currentLocale][key], params)
}

export function languageDisplayName(locale: AdapterLocale): string {
  return catalogs[currentLocale][`language.name.${locale}`]
}

export function supportedLanguageList(): string {
  return ADAPTER_LOCALES.map((locale) => `- ${languageDisplayName(locale)}`).join('\n')
}

export function localeCodes(): string {
  return ADAPTER_LOCALES.join('|')
}

const LANGUAGE_COMMAND = /^\/(?:language|lang|ngon-ngu|语言)(?:\s+(\S+))?$/i

/**
 * Handle `/language` (and aliases) entirely, including persistence.
 * Returns the reply to send, or null when the text is not a language command.
 */
export function handleLanguageCommand(text: string): string | null {
  const match = LANGUAGE_COMMAND.exec(text.trim())
  if (!match) return null

  const requested = match[1]
  if (!requested) {
    return t('language.current', {
      language: languageDisplayName(currentLocale),
      languages: supportedLanguageList(),
    })
  }

  const locale = setAdapterLanguage(requested)
  if (!locale) {
    return t('language.invalid', {
      value: requested,
      languages: localeCodes(),
    })
  }
  return t('language.changed', { language: languageDisplayName(locale) })
}
