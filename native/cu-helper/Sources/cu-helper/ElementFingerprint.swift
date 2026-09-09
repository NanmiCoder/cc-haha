//
//  ElementFingerprint.swift
//  cu-helper
//
//  Stable semantic identity for one element in an AXTree snapshot. Dynamic
//  values are represented only by their kind so editing text or toggling a
//  control does not invalidate an otherwise unchanged locator.
//

import Foundation

struct ElementFingerprint: Sendable, Hashable {
    let role: String
    let subrole: String?
    let identifier: String?
    let title: String?
    let label: String?
    let valueKind: String?

    init(
        role: String,
        subrole: String?,
        identifier: String?,
        title: String?,
        label: String? = nil,
        valueKind: String?
    ) {
        self.role = role
        self.subrole = subrole
        self.identifier = identifier
        self.title = title
        self.label = label
        self.valueKind = valueKind
    }

    func matches(_ other: ElementFingerprint) -> Bool {
        self == other
    }
}

/// Opaque address emitted within one proven pid + key-window epoch. The epoch
/// prevents cross-window rebinding while the stable sparse ID can survive
/// explicit refreshes when its immutable locator remains uniquely equal.
struct SnapshotElementHandle: Sendable, Equatable {
    let snapshotID: UInt64
    let index: Int

    init(snapshotID: UInt64, index: Int) {
        precondition(snapshotID > 0)
        precondition(index >= 0)
        self.snapshotID = snapshotID
        self.index = index
    }

    init?(rawValue: String) {
        guard rawValue.first == "g" else { return nil }
        let parts = rawValue.dropFirst().split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2,
              let snapshotID = UInt64(parts[0]),
              snapshotID > 0,
              let index = Int(parts[1]),
              index >= 0
        else { return nil }

        self.init(snapshotID: snapshotID, index: index)
        guard self.rawValue == rawValue else { return nil }
    }

    var rawValue: String {
        "g\(snapshotID):\(index)"
    }
}

/// Immutable topology evidence for one parent→child hop. An ordinal alone is
/// never enough: every sibling fingerprint and their order must still match.
/// A duplicate featureless wrapper may be selected only when its ordered direct
/// child topology is unique among the otherwise-identical siblings.
struct SnapshotPathStep: Sendable, Hashable {
    let selectedIndex: Int
    let childFingerprints: [ElementFingerprint]
    private let selectedChildTopology: [ElementFingerprint]?

    init?(
        selectedIndex: Int,
        childFingerprints: [ElementFingerprint],
        childTopologyAt: ((Int) -> [ElementFingerprint]?)? = nil
    ) {
        guard childFingerprints.indices.contains(selectedIndex) else { return nil }
        let selected = childFingerprints[selectedIndex]
        let matchingIndices = childFingerprints.indices.filter {
            selected.matches(childFingerprints[$0])
        }
        if matchingIndices.count == 1 {
            selectedChildTopology = nil
        } else {
            guard let childTopologyAt,
                  let selectedTopology = childTopologyAt(selectedIndex)
            else { return nil }
            var topologyMatches = 0
            for index in matchingIndices {
                let topology: [ElementFingerprint]?
                if index == selectedIndex {
                    topology = selectedTopology
                } else {
                    topology = childTopologyAt(index)
                }
                guard let topology else { return nil }
                if topology == selectedTopology { topologyMatches += 1 }
            }
            guard topologyMatches == 1 else { return nil }
            selectedChildTopology = selectedTopology
        }
        self.selectedIndex = selectedIndex
        self.childFingerprints = childFingerprints
    }

    func selectedIndex(
        in currentFingerprints: [ElementFingerprint],
        childTopologyAt: ((Int) -> [ElementFingerprint]?)? = nil
    ) -> Int? {
        guard childFingerprints == currentFingerprints else { return nil }
        let selected = childFingerprints[selectedIndex]
        let matchingIndices = currentFingerprints.indices.filter {
            selected.matches(currentFingerprints[$0])
        }
        guard let selectedChildTopology else {
            return matchingIndices.count == 1 ? matchingIndices[0] : nil
        }
        guard let childTopologyAt else { return nil }
        var topologyMatches: [Int] = []
        for index in matchingIndices {
            guard let topology = childTopologyAt(index) else { return nil }
            if topology == selectedChildTopology {
                topologyMatches.append(index)
            }
        }
        return topologyMatches.count == 1 ? topologyMatches[0] : nil
    }
}

/// Pure fail-closed rules shared by snapshot-time AX↔CG window mapping. Direct
/// IDs must belong to the target process's candidates; fallback title evidence
/// must be symmetric, and root IDs must be 1:1.
enum SnapshotWindowIdentityEvidence {
    struct Candidate: Sendable, Equatable {
        let id: UInt32
        let frameMatches: Bool
        let title: String?
    }

    static func titlesMatch(axTitle: String?, cgTitle: String?) -> Bool {
        normalizedTitle(axTitle) == normalizedTitle(cgTitle)
    }

    /// Select a WindowServer identity without trusting AX window order. Prefer
    /// the native ID, with exact frame + bilateral title as a fallback. Stage
    /// Manager can expose only thumbnail bounds for background windows; when no
    /// candidate matches the AX frame at all, a unique bilateral non-empty title
    /// match is the last fallback. Any ambiguity still fails closed.
    static func mappedWindowID(
        axTitle: String?,
        candidates: [Candidate],
        nativeWindowID: UInt32? = nil
    ) -> UInt32? {
        if let nativeWindowID, nativeWindowID != 0 {
            // A direct ID is stronger than a mutable title or frame. Never
            // fall back to another window when that ID is missing from the
            // target PID's live candidates (closed, wrong process, or layer).
            let matches = candidates.filter { $0.id == nativeWindowID }
            return matches.count == 1 ? nativeWindowID : nil
        }
        let frameMatches = candidates.filter(\.frameMatches)
        let framedEvidence = frameMatches.filter {
            titlesMatch(axTitle: axTitle, cgTitle: $0.title)
        }
        if framedEvidence.count == 1 { return framedEvidence[0].id }

        guard frameMatches.isEmpty,
              normalizedTitle(axTitle) != nil
        else { return nil }
        let titleEvidence = candidates.filter {
            titlesMatch(axTitle: axTitle, cgTitle: $0.title)
        }
        guard titleEvidence.count == 1 else { return nil }
        return titleEvidence[0].id
    }

    /// If any accepted CG id maps to multiple AX roots, none of this snapshot's
    /// roots are trusted. Keeping all roots unverifiable avoids partially using
    /// an internally contradictory mapping.
    static func validateUniqueRootIDs(_ mappedIDs: [UInt32?]) -> [UInt32?] {
        let accepted = mappedIDs.compactMap { $0 }
        guard Set(accepted).count == accepted.count else {
            return Array(repeating: nil, count: mappedIDs.count)
        }
        return mappedIDs
    }

    private static func normalizedTitle(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }
}
