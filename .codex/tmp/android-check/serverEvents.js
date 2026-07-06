// @bun
// android/src/lib/serverEvents.ts
function createMessageId(prefix) {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
function buildUserMessagePayload(text) {
  return {
    type: "user_message",
    content: text.trim()
  };
}
function createLocalUserMessage(text, makeId = () => createMessageId("user")) {
  return {
    id: makeId(),
    type: "user",
    content: text.trim(),
    timestamp: new Date().toISOString()
  };
}
function reduceServerEvent(state, event, makeId = () => createMessageId("assistant")) {
  switch (event.type) {
    case "content_delta":
      if (typeof event.text !== "string" || event.text.length === 0) {
        return state;
      }
      return appendAssistantDelta(state, event.text, makeId);
    case "message_complete":
      return {
        ...state,
        streamingAssistantId: null,
        sending: false
      };
    case "error":
      return {
        ...state,
        streamingAssistantId: null,
        sending: false,
        messages: [
          ...state.messages,
          {
            id: createMessageId("error"),
            type: "system",
            content: event.message || "Remote session error",
            timestamp: new Date().toISOString()
          }
        ]
      };
    case "status":
    case "connected":
    case "content_start":
    case "tool_use_complete":
    case "tool_result":
    case "thinking":
    case "pong":
      return state;
    default:
      return state;
  }
}
function appendAssistantDelta(state, text, makeId) {
  const streamingId = state.streamingAssistantId || makeId();
  const existingIndex = state.messages.findIndex((message) => message.id === streamingId);
  if (existingIndex >= 0) {
    const existing = state.messages[existingIndex];
    const updated = {
      ...existing,
      content: `${typeof existing.content === "string" ? existing.content : ""}${text}`
    };
    return {
      ...state,
      streamingAssistantId: streamingId,
      messages: [
        ...state.messages.slice(0, existingIndex),
        updated,
        ...state.messages.slice(existingIndex + 1)
      ]
    };
  }
  return {
    ...state,
    streamingAssistantId: streamingId,
    messages: [
      ...state.messages,
      {
        id: streamingId,
        type: "assistant",
        content: text,
        timestamp: new Date().toISOString()
      }
    ]
  };
}
export {
  reduceServerEvent,
  createMessageId,
  createLocalUserMessage,
  buildUserMessagePayload
};
