import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import path from "path"
import { Global } from "../../src/global"
import { Installation } from "../../src/installation"
import { Database } from "../../src/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const file = path.basename(Database.Path)
    const shared = "opencode.db"
    const custom = `opencode-${Installation.CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
    const sharedPath = path.join(Global.Path.data, shared)
    const expected = ["latest", "beta"].includes(Installation.CHANNEL)
      ? shared
      : existsSync(sharedPath)
        ? shared
        : custom
    expect(file).toBe(expected)
  })
})
