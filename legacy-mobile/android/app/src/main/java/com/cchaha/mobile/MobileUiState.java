package com.cchaha.mobile;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** A bounded allowlist, never a general localStorage or cookie migration. */
public final class MobileUiState {
  private static boolean session(Object value) { return value instanceof String && ((String) value).matches("[A-Za-z0-9_-]{1,64}"); }
  public static JSONObject sanitize(JSONObject input) {
    if (input == null) return null;
    try {
      if (RemoteProtocol.integer(input, "version") != 1) return null;
      JSONObject output = new JSONObject().put("version", 1);
      Object selected = input.opt("sessionId");
      output.put("sessionId", session(selected) ? selected : JSONObject.NULL);
      JSONArray drafts = new JSONArray(), source = input.optJSONArray("drafts");
      Set<String> used = new HashSet<>();
      if (source != null) for (int i = 0; i < Math.min(source.length(), 5); i++) {
        JSONObject entry = source.optJSONObject(i); if (entry == null || !session(entry.opt("sessionId")) || !(entry.opt("text") instanceof String)) continue;
        String id = entry.getString("sessionId"), text = entry.getString("text");
        if (!used.add(id) || text.getBytes(StandardCharsets.UTF_8).length > 16384) continue;
        drafts.put(new JSONObject().put("sessionId", id).put("text", text));
      }
      return output.put("drafts", drafts);
    } catch (Exception invalid) { return null; }
  }
  private MobileUiState() { }
}
