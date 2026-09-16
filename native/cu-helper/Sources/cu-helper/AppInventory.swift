import AppKit
import Foundation

/// Public native AppInfo shape. Discovery does not grant access to an app.
struct AppInventoryEntry: Encodable, Sendable, Equatable {
    let id: String
    let displayName: String
    var isRunning: Bool
    var lastUsedDate: Date? = nil
    var useCount: Int? = nil

    private enum CodingKeys: String, CodingKey { case id, displayName, isRunning, lastUsedDate, useCount }

    func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(displayName, forKey: .displayName)
        try values.encode(isRunning, forKey: .isRunning)
        if let lastUsedDate {
            try values.encode(ISO8601DateFormatter().string(from: lastUsedDate), forKey: .lastUsedDate)
        }
        try values.encodeIfPresent(useCount, forKey: .useCount)
    }
}

enum AppInventory {
    static func fromMetadata(_ values: [String: Any]) -> AppInventoryEntry? {
        guard let id = values["kMDItemCFBundleIdentifier"] as? String, !id.isEmpty else { return nil }
        let useCount = (values["kMDItemUseCount"] as? NSNumber)?.intValue
        return AppInventoryEntry(
            id: id,
            displayName: values["kMDItemDisplayName"] as? String ?? id,
            isRunning: false,
            lastUsedDate: values["kMDItemLastUsedDate_Ranking"] as? Date,
            useCount: useCount.flatMap { $0 >= 0 ? $0 : nil }
        )
    }

    static func merge(running: [AppRef], recent: [AppInventoryEntry]) -> [AppInventoryEntry] {
        var metadata: [String: AppInventoryEntry] = [:]
        for app in recent where metadata[app.id] == nil { metadata[app.id] = app }
        var seen = Set<String>()
        var result: [AppInventoryEntry] = []
        for app in running where seen.insert(app.bundleId).inserted {
            result.append(AppInventoryEntry(
                id: app.bundleId, displayName: app.displayName, isRunning: true,
                lastUsedDate: metadata[app.bundleId]?.lastUsedDate,
                useCount: metadata[app.bundleId]?.useCount
            ))
        }
        for var app in recent where seen.insert(app.id).inserted {
            app.isRunning = false
            result.append(app)
        }
        return result
    }
}

/// The official native catalog combines regular running applications with
/// Spotlight application bundles used in the last fourteen days. Keep a live
/// metadata query so later observations do not rescan the filesystem or render
/// icons. A bounded initial gather also works when Spotlight is unavailable.
@MainActor
final class RecentAppCatalog {
    static let shared = RecentAppCatalog()
    private var query: NSMetadataQuery?
    private let keys = ["kMDItemCFBundleIdentifier", "kMDItemDisplayName", "kMDItemLastUsedDate_Ranking", "kMDItemUseCount"]

    func entries() async throws -> [AppInventoryEntry] {
        if query == nil {
            let metadata = NSMetadataQuery()
            metadata.searchScopes = [NSMetadataQueryLocalComputerScope]
            metadata.predicate = NSPredicate(
                format: "kMDItemContentType == %@ AND kMDItemFSName LIKE %@ AND kMDItemLastUsedDate_Ranking >= %@",
                "com.apple.application-bundle", "*.app",
                Calendar.current.startOfDay(for: Date()).addingTimeInterval(-14 * 24 * 60 * 60) as NSDate
            )
            guard metadata.start() else { return [] }
            query = metadata
        }
        guard let query else { return [] }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while query.isGathering && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        try Task.checkCancellation()
        query.disableUpdates()
        defer { query.enableUpdates() }
        return query.results.compactMap { result in
            guard let item = result as? NSMetadataItem else { return nil }
            var values: [String: Any] = [:]
            for key in keys { values[key] = item.value(forAttribute: key) }
            return AppInventory.fromMetadata(values)
        }
    }
}
