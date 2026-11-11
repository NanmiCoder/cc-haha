package com.cchaha.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Set;

/** v3 remembers the last opened identity without changing connection trust. */
public final class ComputerRecords {
  private final JSONObject root;
  public ComputerRecords(String json) throws JSONException {
    Object old = new JSONTokener(json == null || json.trim().isEmpty() ? "{}" : json).nextValue();
    if (!(old instanceof JSONArray) && !(old instanceof JSONObject)) throw new JSONException("invalid_computer_store");
    root = old instanceof JSONObject ? (JSONObject) old : new JSONObject();
    if (root.optInt("version", 0) > 3) throw new JSONException("unsupported_computer_store_version");
    JSONArray input = old instanceof JSONArray ? (JSONArray) old : root.optJSONArray("computers");
    LinkedHashMap<String, JSONObject> normalized = new LinkedHashMap<>();
    if (input != null) for (int i = 0; i < input.length(); i++) {
      JSONObject entry = input.optJSONObject(i); if (entry == null) continue;
      try {
        String address = entry.optString("origin", "");
        RemoteUrl url = RemoteUrl.parse(address.isEmpty() ? entry.optString("url") : address + "/remote");
        entry.remove("url"); entry.remove("pairSecret"); entry.put("origin", url.origin);
        if (!entry.has("name")) entry.put("name", java.net.URI.create(url.origin).getHost());
        if (entry.has("hostId")) {
          String key = entry.getString("hostKey");
          RemoteProtocol.equal(entry.getString("hostId"), RemoteProtocol.hostId(key));
          entry.put("directory", RemoteUrl.requireOrigin(entry.getString("directory")));
          if (!entry.optString("keyAlias").matches("cc-haha-device-[a-f0-9]{64}-[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("invalid_key_alias");
          if (entry.has("deviceId") && !RemoteProtocol.isNonce(entry.getString("deviceId"))) throw new IllegalArgumentException("invalid_device");
          if (entry.optLong("sequence", 0) < 0) throw new IllegalArgumentException("invalid_sequence");
          entry.put("legacy", false);
        } else entry.put("legacy", true);
        addProfile(entry, profileName(entry));
        JSONObject previous = normalized.get(id(entry));
        if (previous == null) normalized.put(id(entry), entry);
        else {
          Iterator<String> fields = entry.keys();
          while (fields.hasNext()) { String field = fields.next(); if (!previous.has(field)) previous.put(field, entry.get(field)); }
          for (String profile : profiles(entry)) addProfile(previous, profile);
          if (isBound(entry) && entry.optLong("sequence", 0) > previous.optLong("sequence", 0)) {
            previous.put("sequence", entry.optLong("sequence")); previous.put("origin", entry.getString("origin"));
          }
        }
      } catch (IllegalArgumentException error) {
        if (entry.has("hostId")) throw new JSONException("invalid_bound_computer");
        // Unsafe historical addresses must not become navigable hosts.
      }
    }
    int previousVersion = root.optInt("version", 0);
    root.put("computers", new JSONArray(normalized.values()));
    // An older store never recorded selection. Resume only its unambiguous bound
    // computer; multiple computers and temporary origins still need a choice.
    if (previousVersion < 3 && !root.has("lastComputerId")) {
      JSONObject only = null;
      for (JSONObject record : normalized.values()) if (isBound(record)) {
        if (only != null) { only = null; break; }
        only = record;
      }
      root.put("lastComputerId", only == null ? JSONObject.NULL : id(only));
    }
    JSONObject last = find(root.optString("lastComputerId", ""));
    root.put("lastComputerId", last != null && isBound(last) ? id(last) : JSONObject.NULL);
    root.put("version", 3);
    root.put("pendingProfileDeletions", new JSONArray(pendingProfileDeletions()));
    root.put("pendingProfileNames", new JSONArray(pendingProfileNames()));
  }
  public static boolean isBound(JSONObject record) { return record.has("hostId") && record.has("hostKey") && !record.optBoolean("legacy", false); }
  public static String id(JSONObject record) { return isBound(record) ? record.optString("hostId") : "legacy:" + record.optString("origin"); }
  public static String profileName(JSONObject record) { return BrowserProfiles.key(isBound(record) ? record.optString("hostId") : null, record.optString("origin")); }
  public JSONArray computers() { return root.optJSONArray("computers"); }
  public JSONObject find(String identifier) {
    for (int i = 0; i < computers().length(); i++) {
      JSONObject entry = computers().optJSONObject(i);
      if (id(entry).equals(identifier) || (!isBound(entry) && entry.optString("origin").equals(identifier))) return entry;
    }
    return null;
  }
  public JSONObject lastComputer() { return find(root.optString("lastComputerId", "")); }
  public void opened(JSONObject record) throws JSONException {
    if (find(id(record)) == record && isBound(record)) root.put("lastComputerId", id(record));
  }
  public JSONObject add(RemoteUrl url, String name) throws JSONException {
    String identifier = url.hostId == null ? "legacy:" + url.origin : url.hostId;
    JSONObject existing = find(identifier);
    if (existing != null) {
      if (url.hostId != null) {
        // A new QR can locate the same pinned host, but cannot replace its directory trust.
        RemoteProtocol.equal(existing.getString("hostKey"), url.hostKey);
        RemoteProtocol.equal(existing.getString("directory"), url.directory);
      }
      return existing;
    }
    JSONObject entry = url.hostId == null ? null : find("legacy:" + url.origin);
    if (entry == null) { entry = new JSONObject().put("name", name).put("origin", url.origin); computers().put(entry); }
    if (url.hostId != null) {
      entry.put("legacy", false).put("hostId", url.hostId).put("hostKey", url.hostKey).put("directory", url.directory)
          .put("keyAlias", "cc-haha-device-" + url.hostId + "-" + RemoteProtocol.nonce()).put("sequence", 0);
    } else entry.put("legacy", true);
    addProfile(entry, profileName(entry));
    return entry;
  }
  public void connected(JSONObject record, ReconnectClient.Result result) throws JSONException {
    if (!isBound(record) || result.sequence < record.optLong("sequence", 0)) throw new IllegalArgumentException("connection_rollback");
    record.put("origin", RemoteUrl.requireOrigin(result.origin)).put("sequence", result.sequence);
    if (result.deviceId != null && !result.deviceId.isEmpty()) record.put("deviceId", result.deviceId);
    if (result.hostName != null && !result.hostName.trim().isEmpty() && !record.optBoolean("customName")) record.put("name", result.hostName.substring(0, Math.min(80, result.hostName.length())));
    addProfile(record, profileName(record));
  }
  public void rename(String identifier, String name) throws JSONException { JSONObject record = find(identifier); if (record != null) record.put("name", name).put("customName", true); }
  public void remove(String identifier) {
    for (int i = computers().length() - 1; i >= 0; i--) {
      JSONObject entry = computers().optJSONObject(i);
      if (id(entry).equals(identifier) || (!isBound(entry) && entry.optString("origin").equals(identifier))) {
        if (id(entry).equals(root.optString("lastComputerId", ""))) root.remove("lastComputerId");
        computers().remove(i);
      }
    }
  }
  public String serialize() { return root.toString(); }
  public static Set<String> profiles(JSONObject record) {
    Set<String> names = new LinkedHashSet<>(); JSONArray input = record.optJSONArray("profiles");
    if (input != null) for (int i = 0; i < input.length(); i++) { String name = input.optString(i); if (name.matches("computer-[a-f0-9]{64}")) names.add(name); }
    return names;
  }
  private static void addProfile(JSONObject record, String name) throws JSONException { Set<String> names = profiles(record); names.add(name); record.put("profiles", new JSONArray(names)); }
  public Set<String> pendingProfileNames() {
    Set<String> result = new LinkedHashSet<>(); JSONArray input = root.optJSONArray("pendingProfileNames");
    if (input != null) for (int i = 0; i < input.length(); i++) if (input.optString(i).matches("computer-[a-f0-9]{64}")) result.add(input.optString(i));
    return result;
  }
  public void setPendingProfileName(String name, boolean pending) throws JSONException {
    Set<String> names = pendingProfileNames(); if (pending) names.add(name); else names.remove(name); root.put("pendingProfileNames", new JSONArray(names));
  }
  public Set<String> pendingProfileDeletions() {
    Set<String> result = new LinkedHashSet<>(); JSONArray pending = root.optJSONArray("pendingProfileDeletions");
    if (pending != null) for (int i = 0; i < pending.length(); i++) {
      try { result.add(RemoteUrl.parse(pending.optString(i) + "/remote").origin); } catch (IllegalArgumentException ignored) { }
    }
    return result;
  }
  public void setPendingProfileDeletion(String origin, boolean pending) throws JSONException {
    Set<String> origins = pendingProfileDeletions(); if (pending) origins.add(origin); else origins.remove(origin); root.put("pendingProfileDeletions", new JSONArray(origins));
  }
}
