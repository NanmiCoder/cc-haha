package com.cchaha.mobile;

import org.json.JSONObject;

/** No redirects, no logging, bounded response size; cookies stay at their origin. */
public final class SessionProbe {
  public enum State { CHECKING, ONLINE, UNPAIRED, OFFLINE, INCOMPATIBLE, LEGACY, IDENTITY_FAILED, PAIR_REQUIRED }
  public static final class Result {
    public final State state;
    public final String hostName;
    Result(State state, String hostName) { this.state = state; this.hostName = hostName; }
  }

  public static Result read(String origin, String cookie) {
    try {
      NativeTransport.Reply reply = new NativeTransport.Https().request(origin, "/api/public-access/session", null, cookie);
      if (reply.status != 200) return new Result(State.OFFLINE, null);
      JSONObject data = reply.body;
      if (!(data.opt("authenticated") instanceof Boolean) || data.optInt("protocolVersion", 1) != 1) return new Result(State.INCOMPATIBLE, null);
      return data.getBoolean("authenticated") ? new Result(State.ONLINE, data.optString("hostName", null)) : new Result(State.UNPAIRED, null);
    } catch (Exception ignored) { return new Result(State.OFFLINE, null); }
  }
}
