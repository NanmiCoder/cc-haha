package com.cchaha.mobile;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public class MobileUiStateTest {
  @Test public void allowsOnlySessionAndPlainTextDrafts() throws Exception {
    JSONObject value = MobileUiState.sanitize(new JSONObject().put("version", 1).put("sessionId", "session_123").put("cookie", "secret")
      .put("drafts", new JSONArray().put(new JSONObject().put("sessionId", "s1").put("text", "unsent 中文").put("attachments", "private-path"))));
    assertEquals("session_123", value.getString("sessionId"));
    assertEquals("unsent 中文", value.getJSONArray("drafts").getJSONObject(0).getString("text"));
    assertFalse(value.toString().contains("secret")); assertFalse(value.toString().contains("private-path"));
  }
  @Test public void boundsCountBytesAndRejectsMalformedSessionIds() throws Exception {
    JSONArray drafts = new JSONArray();
    for (int i=0;i<8;i++) drafts.put(new JSONObject().put("sessionId", "s"+i).put("text", "ok"));
    assertEquals(5, MobileUiState.sanitize(new JSONObject().put("version",1).put("drafts",drafts)).getJSONArray("drafts").length());
    JSONObject value=MobileUiState.sanitize(new JSONObject().put("version",1).put("sessionId","https://evil").put("drafts", new JSONArray()
      .put(new JSONObject().put("sessionId","s").put("text","中".repeat(6000)))
      .put(new JSONObject().put("sessionId","../escape").put("text","bad"))));
    assertTrue(value.isNull("sessionId")); assertEquals(0,value.getJSONArray("drafts").length());
    assertNull(MobileUiState.sanitize(new JSONObject().put("version",2)));
  }
}
