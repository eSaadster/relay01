import { describe, expect, it } from "vitest";
import { callDescriptor, matchesRule, requiresApproval, type ApprovalConfig } from "./approvals.js";

describe("callDescriptor", () => {
  it("uses the lowercase tool name for plain tools", () => {
    expect(callDescriptor("Bash", { command: "ls" })).toBe("bash");
    expect(callDescriptor("write_file", { path: "x" })).toBe("write_file");
  });

  it("expands mcp call actions to mcp:server:tool", () => {
    expect(callDescriptor("mcp", { action: "call", server: "linear", tool: "create_issue" })).toBe(
      "mcp:linear:create_issue",
    );
  });

  it("leaves non-call mcp actions as plain mcp", () => {
    expect(callDescriptor("mcp", { action: "list-tools", server: "linear" })).toBe("mcp");
  });
});

describe("matchesRule", () => {
  it("matches exact names case-insensitively", () => {
    expect(matchesRule("bash", "Bash")).toBe(true);
    expect(matchesRule("bash2", "bash")).toBe(false);
  });

  it("supports * wildcards", () => {
    expect(matchesRule("mcp:linear:create_issue", "mcp:linear:*create*")).toBe(true);
    expect(matchesRule("mcp:linear:get_issue", "mcp:linear:*create*")).toBe(false);
    expect(matchesRule("mcp:notion:anything", "mcp:notion:*")).toBe(true);
  });

  it("escapes regex metacharacters in rules", () => {
    expect(matchesRule("mcp:a.b:tool", "mcp:a.b:tool")).toBe(true);
    expect(matchesRule("mcp:aXb:tool", "mcp:a.b:tool")).toBe(false);
  });
});

describe("requiresApproval", () => {
  const config: ApprovalConfig = { rules: ["mcp:linear:*create*", "bash"], timeoutSeconds: 300 };

  it("returns false with no config", () => {
    expect(requiresApproval(null, "bash")).toBe(false);
  });

  it("returns true only for matching descriptors", () => {
    expect(requiresApproval(config, "bash")).toBe(true);
    expect(requiresApproval(config, "mcp:linear:create_issue")).toBe(true);
    expect(requiresApproval(config, "read_file")).toBe(false);
    expect(requiresApproval(config, "mcp:linear:list_issues")).toBe(false);
  });
});
