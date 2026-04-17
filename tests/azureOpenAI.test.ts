import { expect, test } from "bun:test"
import {
  buildAzureOpenAIInput,
  resolveAzureOpenAIEndpoint,
  resolveAzureOpenAIDeployment,
} from "../src/services/api/azureOpenAI.js"

test("resolveAzureOpenAIEndpoint appends responses path and api-version", () => {
  const prevBase = process.env.AZURE_OPENAI_BASE_URL
  const prevVersion = process.env.AZURE_OPENAI_API_VERSION
  process.env.AZURE_OPENAI_BASE_URL =
    "https://example.cognitiveservices.azure.com/"
  process.env.AZURE_OPENAI_API_VERSION = "2025-04-01-preview"

  const url = resolveAzureOpenAIEndpoint()
  expect(url).toContain("/openai/responses")
  expect(url).toContain("api-version=2025-04-01-preview")

  process.env.AZURE_OPENAI_BASE_URL = prevBase
  process.env.AZURE_OPENAI_API_VERSION = prevVersion
})

test("buildAzureOpenAIInput maps tool_use and tool_result", () => {
  const input = buildAzureOpenAIInput([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running tool" },
          {
            type: "tool_use",
            id: "tool_1",
            name: "my_tool",
            input: { foo: "bar" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: [{ type: "text", text: "ok" }],
          },
        ],
      },
    },
  ])

  expect(input.some(msg => msg.role === "assistant")).toBe(true)
  expect(input.some(msg => msg.role === "tool")).toBe(true)
})

test("resolveAzureOpenAIDeployment throws when codex mapping is missing", () => {
  const prevBase = process.env.AZURE_OPENAI_BASE_URL
  const prevEnv = process.env.AZURE_OPENAI_CODEX_DEPLOYMENT
  process.env.AZURE_OPENAI_BASE_URL =
    "https://example.cognitiveservices.azure.com/"
  delete process.env.AZURE_OPENAI_CODEX_DEPLOYMENT

  expect(() => resolveAzureOpenAIDeployment("gpt-5.2-codex")).toThrow()
  expect(() => resolveAzureOpenAIDeployment("gpt-5.3-codex")).toThrow()
  expect(() => resolveAzureOpenAIDeployment("gpt-5.4-codex")).toThrow()

  process.env.AZURE_OPENAI_BASE_URL = prevBase
  process.env.AZURE_OPENAI_CODEX_DEPLOYMENT = prevEnv
})

test("resolveAzureOpenAIDeployment uses env default even if name matches", () => {
  const prevBase = process.env.AZURE_OPENAI_BASE_URL
  const prevEnv = process.env.AZURE_OPENAI_CODEX_DEPLOYMENT
  process.env.AZURE_OPENAI_BASE_URL =
    "https://example.cognitiveservices.azure.com/"
  process.env.AZURE_OPENAI_CODEX_DEPLOYMENT = "gpt-5.2-codex"

  const resolved = resolveAzureOpenAIDeployment("gpt-5.2-codex")
  expect(resolved).toBe("gpt-5.2-codex")

  process.env.AZURE_OPENAI_BASE_URL = prevBase
  process.env.AZURE_OPENAI_CODEX_DEPLOYMENT = prevEnv
})
