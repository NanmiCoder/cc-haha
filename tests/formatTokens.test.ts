import { describe, expect, test } from "bun:test"
import { formatNumber, formatTokens } from "../src/utils/format.js"

// The spinner rows render token counts via formatTokens (issue #757): same
// compact notation as formatNumber, but without the ".0" artifact ("1k", not
// "1.0k").
describe("formatTokens", () => {
  test("keeps counts below 1000 verbatim", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
  })

  test("compacts thousands with one decimal", () => {
    expect(formatTokens(1234)).toBe("1.2k")
    expect(formatTokens(38_500)).toBe("38.5k")
  })

  test("drops the trailing .0 that formatNumber keeps", () => {
    expect(formatNumber(1000)).toBe("1.0k")
    expect(formatTokens(1000)).toBe("1k")
    expect(formatTokens(2_000_000)).toBe("2m")
  })
})
