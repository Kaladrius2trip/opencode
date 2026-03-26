import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import path from "path"
import { Global } from "../../src/global"
import { Installation } from "../../src/installation"
import { Database } from "../../src/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const sharedPath = path.join(Global.Path.data, "opencode.db")
    const expected = ["latest", "beta"].includes(Installation.CHANNEL)
      ? sharedPath
      : existsSync(sharedPath)
        ? sharedPath
        : path.join(Global.Path.data, `opencode-${Installation.CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })
})
