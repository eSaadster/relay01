import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSandboxPath,
  createSearchTool,
  parseSkillInvocation,
  type SessionContext,
} from "./pi-agent-tools.js";

let base: string;
let ctx: SessionContext;

beforeEach(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-")),
  );
  const sessionRoot = path.join(base, "@tester");
  const sessionCwd = path.join(sessionRoot, "scratchpad");
  fs.mkdirSync(sessionCwd, { recursive: true });
  fs.writeFileSync(path.join(sessionCwd, "notes.txt"), "hello world\n");
  fs.writeFileSync(path.join(base, "secret.env"), "TOKEN=x\n");
  ctx = { sessionName: "@tester", sessionCwd, sessionRoot };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("createSandboxPath", () => {
  it("refuses symlinks that point outside the sandbox", () => {
    fs.symlinkSync(
      path.join(base, "secret.env"),
      path.join(ctx.sessionCwd, "x"),
    );
    fs.symlinkSync(base, path.join(ctx.sessionCwd, "up"));
    const sandboxPath = createSandboxPath(ctx);
    expect(() => sandboxPath("x", true)).toThrow(/outside sandbox/);
    expect(() => sandboxPath("up/new.txt", false, true)).toThrow(
      /outside sandbox/,
    );
  });

  it("refuses a dangling symlink", () => {
    fs.symlinkSync(
      path.join(base, "created.txt"),
      path.join(ctx.sessionCwd, "d"),
    );
    expect(() => createSandboxPath(ctx)("d", false, true)).toThrow(
      /dangling symlink/,
    );
  });
});

describe("search tool", () => {
  const search = async (params: Record<string, unknown>) => {
    const res = await createSearchTool(ctx).execute("c", params as never);
    return (res.content[0] as { text: string }).text;
  };

  it("finds matches", async () => {
    expect(await search({ pattern: "hello" })).toContain(
      "notes.txt:1:hello world",
    );
  });

  it("does not run shell syntax from the pattern or filePattern", async () => {
    const marker = path.join(base, "pwned");
    await search({ pattern: `$(touch ${marker})` });
    await search({ pattern: "x", filePattern: `\`touch ${marker}\`` });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("parseSkillInvocation", () => {
  let skills: string;
  let script: string;

  beforeEach(() => {
    skills = path.join(base, "skills");
    fs.mkdirSync(path.join(skills, "s", "files"), { recursive: true });
    script = path.join(skills, "s", "run.sh");
    fs.writeFileSync(script, "echo ok\n");
    fs.writeFileSync(path.join(skills, "s", "files", "x.sh"), "echo x\n");
  });

  it("accepts a skill script with plain args", () => {
    expect(
      parseSkillInvocation(`bash ${script} one "two words" 'three'`, [skills]),
    ).toEqual({
      file: "bash",
      args: [script, "one", "two words", "three"],
    });
  });

  it("rejects anything chained, comment-tagged, or outside the skills dir", () => {
    const writable = [path.join(skills, "s", "files")];
    for (const cmd of [
      "cat ~/relay01/slack/.env # pdf",
      `bash ${script}; cat /etc/passwd`,
      `bash ${script} && id`,
      `bash ${script} $(id)`,
      `bash ${script} | tee out`,
      `python -c 'import os' ${script}`,
      `bash ${path.join(skills, "s", "files", "x.sh")}`,
    ]) {
      expect(parseSkillInvocation(cmd, [skills], writable)).toBeNull();
    }
  });
});
