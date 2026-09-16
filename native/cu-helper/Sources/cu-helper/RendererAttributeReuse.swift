/// Successful scalar observations owned by one render invocation only.
/// Missing/failed reads deliberately remain retryable. Never store this in a
/// published snapshot or reuse it for action-time identity/focus validation.
@MainActor
final class RendererAttributeReuse {
    private var titleValue: String?
    private var descriptionValue: String?
    private var roleValue: String?
    private var settableValue: Bool?

    init(title: String?, description: String?, role: String?) {
        titleValue = title
        descriptionValue = description
        roleValue = role
    }

    func title(read: () -> String?) -> String? {
        if let value = titleValue { return value }
        let value = read()
        if let value { titleValue = value }
        return value
    }
    func description(read: () -> String?) -> String? {
        if let value = descriptionValue { return value }
        let value = read()
        if let value { descriptionValue = value }
        return value
    }
    func role(read: () -> String?) -> String? {
        if let value = roleValue { return value }
        let value = read()
        if let value { roleValue = value }
        return value
    }
    func settable(read: () -> Bool?) -> Bool? {
        if let value = settableValue { return value }
        let value = read()
        if let value { settableValue = value }
        return value
    }
}
