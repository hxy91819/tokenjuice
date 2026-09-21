import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  doctorKiroHook,
  doctorKiroSteering,
  installKiroHook,
  installKiroSteering,
  runKiroPreToolUseHook,
  uninstallKiroHook,
  uninstallKiroSteering,
} from "../../src/index.js";

const tempDirs: string[] = [];
const originalProjectDir = process.env.KIRO_PROJECT_DIR;

function kiroEvent(command: string, toolName = "shell"): string {
  return JSON.stringify({
    hook_event_name: "preToolUse",
    tool_name: toolName,
    tool_input: { command },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalProjectDir === undefined) {
    delete process.env.KIRO_PROJECT_DIR;
  } else {
    process.env.KIRO_PROJECT_DIR = originalProjectDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenjuice-kiro-test-"));
  tempDirs.push(dir);
  return dir;
}

async function createLocalLauncher(projectDir: string): Promise<string> {
  const launcher = join(projectDir, "tokenjuice-main.js");
  await writeFile(launcher, "// test launcher\n", "utf8");
  return launcher;
}

describe("kiro native hook", () => {
  it("installs a workspace agent with a native shell PreToolUse hook and companion steering", async () => {
    const projectDir = await createTempDir();
    const binaryPath = await createLocalLauncher(projectDir);

    const result = await installKiroHook(undefined, {
      projectDir,
      local: true,
      binaryPath,
      nodePath: process.execPath,
    });
    const agent = JSON.parse(await readFile(result.agentPath, "utf8")) as {
      name: string;
      description: string;
      tools: string[];
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    const steering = await readFile(result.steeringPath, "utf8");

    expect(result.agentPath).toBe(join(projectDir, ".kiro", "agents", "tokenjuice.json"));
    expect(result.steeringPath).toBe(join(projectDir, ".kiro", "steering", "tokenjuice.md"));
    expect(agent.name).toBe("tokenjuice");
    expect(agent.description).toContain("tokenjuice native shell guard");
    expect(agent.tools).toContain("@builtin");
    expect(agent.hooks.preToolUse).toEqual([
      expect.objectContaining({
        matcher: "shell",
        timeout_ms: 5_000,
        cache_ttl_seconds: 0,
      }),
    ]);
    expect(agent.hooks.preToolUse[0]?.command).toContain("kiro-pre-tool-use");
    expect(agent.hooks.preToolUse[0]?.command).toContain("--wrap-launcher");
    expect(steering).toContain("inclusion: always");
    expect(steering).toContain("kiro-cli chat --agent tokenjuice");
    expect(steering).toContain("tokenjuice wrap -- <command>");
    expect(steering).toContain("tokenjuice wrap --raw -- <command>");
    expect(steering).not.toContain("wrap --full");
  });

  it("backs up existing agent and steering files before replacing them", async () => {
    const projectDir = await createTempDir();
    const binaryPath = await createLocalLauncher(projectDir);
    const agentPath = join(projectDir, ".kiro", "agents", "tokenjuice.json");
    const steeringPath = join(projectDir, ".kiro", "steering", "tokenjuice.md");
    await mkdir(join(projectDir, ".kiro", "agents"), { recursive: true });
    await mkdir(join(projectDir, ".kiro", "steering"), { recursive: true });
    await writeFile(agentPath, "{\"name\":\"local\"}\n", "utf8");
    await writeFile(steeringPath, "# local steering\n", "utf8");

    const result = await installKiroHook(undefined, { projectDir, local: true, binaryPath });

    expect(result.agentBackupPath).toBe(`${agentPath}.bak`);
    expect(result.steeringBackupPath).toBe(`${steeringPath}.bak`);
    await expect(readFile(`${agentPath}.bak`, "utf8")).resolves.toContain("local");
    await expect(readFile(`${steeringPath}.bak`, "utf8")).resolves.toContain("local steering");
  });

  it("reports healthy native hook wiring", async () => {
    const projectDir = await createTempDir();
    const binaryPath = await createLocalLauncher(projectDir);
    const options = { projectDir, local: true, binaryPath, nodePath: process.execPath };
    await installKiroHook(undefined, options);

    const doctor = await doctorKiroHook(undefined, options);

    expect(doctor.status).toBe("ok");
    expect(doctor.issues).toEqual([]);
    expect(doctor.detectedCommand).toBe(doctor.expectedCommand);
    expect(doctor.advisories[0]).toContain("cannot rewrite tool input");
  });

  it("reports missing and stale native hook wiring", async () => {
    const projectDir = await createTempDir();
    const binaryPath = await createLocalLauncher(projectDir);
    const options = { projectDir, local: true, binaryPath };

    const disabled = await doctorKiroHook(undefined, options);
    expect(disabled.status).toBe("disabled");

    const installed = await installKiroHook(undefined, options);
    const agent = JSON.parse(await readFile(installed.agentPath, "utf8")) as {
      hooks: { preToolUse: Array<{ matcher: string }> };
    };
    agent.hooks.preToolUse[0]!.matcher = "read";
    await writeFile(installed.agentPath, `${JSON.stringify(agent, null, 2)}\n`, "utf8");

    const broken = await doctorKiroHook(undefined, options);
    expect(broken.status).toBe("broken");
    expect(broken.issues).toContain("configured Kiro tokenjuice hook matcher must target the shell tool");
  });

  it("uninstalls only tokenjuice-owned agent and steering files", async () => {
    const projectDir = await createTempDir();
    const binaryPath = await createLocalLauncher(projectDir);
    await installKiroHook(undefined, { projectDir, local: true, binaryPath });

    const removed = await uninstallKiroHook(undefined, { projectDir });

    expect(removed.removedAgent).toBe(true);
    expect(removed.removedSteering).toBe(true);
    await expect(access(removed.agentPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(removed.steeringPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a markerless user-owned agent during uninstall", async () => {
    const projectDir = await createTempDir();
    const agentPath = join(projectDir, ".kiro", "agents", "tokenjuice.json");
    await mkdir(join(projectDir, ".kiro", "agents"), { recursive: true });
    await writeFile(agentPath, "{\"name\":\"user-owned\"}\n", "utf8");

    const removed = await uninstallKiroHook(undefined, { projectDir });

    expect(removed.removedAgent).toBe(false);
    await expect(readFile(agentPath, "utf8")).resolves.toContain("user-owned");
  });

  it("blocks unwrapped shell commands with an exact safe retry", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await runKiroPreToolUseHook(kiroEvent("pnpm test"), "/opt/tokenjuice");

    expect(code).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("tokenjuice Kiro hook blocked"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("/opt/tokenjuice wrap --source kiro --"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("pnpm test"));
  });

  it("allows only the configured direct or local-build tokenjuice launcher", async () => {
    const direct = await runKiroPreToolUseHook(kiroEvent("tokenjuice wrap -- pnpm test"));
    const localLauncher = "/repo/dist/cli/main.js";
    const local = await runKiroPreToolUseHook(
      kiroEvent(`${process.execPath} ${localLauncher} wrap --source kiro -- /bin/bash -lc 'pnpm test'`),
      localLauncher,
    );

    expect(direct).toBe(0);
    expect(local).toBe(0);
  });

  it("recognizes configured Windows launchers without stripping path separators", async () => {
    const cmdLauncher = String.raw`C:\Tools\tokenjuice.cmd`;
    const nodePath = String.raw`C:\Program Files\nodejs\node.exe`;
    const jsLauncher = String.raw`C:\repo\dist\cli\main.js`;

    const cmd = await runKiroPreToolUseHook(
      kiroEvent(String.raw`C:\Tools\tokenjuice.cmd wrap -- pnpm test`),
      cmdLauncher,
      "win32",
      nodePath,
    );
    const node = await runKiroPreToolUseHook(
      kiroEvent(String.raw`"C:\Program Files\nodejs\node.exe" C:\repo\dist\cli\main.js wrap -- pnpm test`),
      jsLauncher,
      "win32",
      nodePath,
    );

    expect(cmd).toBe(0);
    expect(node).toBe(0);
  });

  it("blocks lookalike wrapper launchers and preserves explicit wrapper options in the retry", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const fakeBinary = await runKiroPreToolUseHook(
      kiroEvent("./tokenjuice wrap --raw -- printf secret"),
      "/opt/tokenjuice",
    );
    const fakeNodeScript = await runKiroPreToolUseHook(
      kiroEvent(`${process.execPath} /tmp/fake.js wrap -- printf bypass`),
      "/repo/dist/cli/main.js",
    );
    const semanticArgs = String.raw`./tokenjuice wrap -- printf "$HOME/file" '*.txt' '' 'a\b'`;
    const semanticRetryStatus = await runKiroPreToolUseHook(kiroEvent(semanticArgs), "/opt/tokenjuice");
    const semanticRetry = String(stderr.mock.calls.at(-1)?.[0]);
    const quotedLauncherStatus = await runKiroPreToolUseHook(
      kiroEvent("'/opt/old wrap dir/tokenjuice' wrap -- printf ok"),
      "/opt/tokenjuice",
    );
    const quotedLauncherRetry = String(stderr.mock.calls.at(-1)?.[0]);
    const ordinaryCommand = await runKiroPreToolUseHook(
      kiroEvent("echo wrap -- rm -rf build"),
    );
    const ordinaryRetry = String(stderr.mock.calls.at(-1)?.[0]);
    const multilineLookalike = await runKiroPreToolUseHook(
      kiroEvent("./tokenjuice wrap -- bash -c 'printf \"a\\nb\"\nprintf done'"),
      "/opt/tokenjuice",
    );
    const multilineRetry = String(stderr.mock.calls.at(-1)?.[0]);

    expect(fakeBinary).toBe(2);
    expect(fakeNodeScript).toBe(2);
    expect(semanticRetryStatus).toBe(2);
    expect(semanticRetry).toContain(String.raw`/opt/tokenjuice wrap -- printf "$HOME/file" '*.txt' '' 'a\b'`);
    expect(quotedLauncherStatus).toBe(2);
    expect(quotedLauncherRetry).toContain("/opt/tokenjuice wrap -- printf ok");
    expect(ordinaryCommand).toBe(2);
    expect(multilineLookalike).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      "/opt/tokenjuice wrap --raw -- printf secret",
    ));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      `${process.execPath} /repo/dist/cli/main.js wrap -- printf bypass`,
    ));
    expect(ordinaryRetry).toContain("echo wrap -- rm -rf build");
    expect(ordinaryRetry).not.toContain("Retry exactly as:\ntokenjuice wrap -- rm -rf build\n");
    expect(multilineRetry).toContain(String.raw`a\nb`);
    expect(multilineRetry).not.toContain("anb");
  });

  it("allows compound commands only when they are quoted inside the wrapper", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const inner = await runKiroPreToolUseHook(
      kiroEvent("tokenjuice wrap -- /bin/bash -lc 'printf one && printf two'"),
    );
    const multilineInner = await runKiroPreToolUseHook(
      kiroEvent("tokenjuice wrap -- /bin/bash -lc 'printf one\nprintf two'"),
    );
    const hashInWord = await runKiroPreToolUseHook(
      kiroEvent("tokenjuice wrap -- cat notes#1.txt"),
    );
    const outer = await runKiroPreToolUseHook(
      kiroEvent("tokenjuice wrap -- printf one && printf bypass"),
    );
    const multilineOuter = await runKiroPreToolUseHook(
      kiroEvent("tokenjuice wrap -- printf one\nprintf bypass"),
    );
    const misleadingQuote = await runKiroPreToolUseHook(
      kiroEvent("tokenjuice wrap -- printf \"'\"\nprintf bypass # '"),
    );
    const commentQuote = await runKiroPreToolUseHook(
      kiroEvent("tokenjuice wrap -- printf one # '\nprintf bypass\n# '"),
    );
    const ansiCQuote = await runKiroPreToolUseHook(
      kiroEvent("tokenjuice wrap -- printf $'a\\\\''\nprintf bypass # '"),
    );

    expect(inner).toBe(0);
    expect(multilineInner).toBe(0);
    expect(hashInWord).toBe(0);
    expect(outer).toBe(2);
    expect(multilineOuter).toBe(2);
    expect(misleadingQuote).toBe(2);
    expect(commentQuote).toBe(2);
    expect(ansiCQuote).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Retry exactly as"));
  });

  it("accepts its generated multiline retry when the inner script uses ANSI-C quotes", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = "printf $'hello\\n'\nprintf done";

    const unwrapped = await runKiroPreToolUseHook(kiroEvent(command));
    const message = String(stderr.mock.calls.at(-1)?.[0]);
    const retry = message.split("Retry exactly as:\n")[1]?.trim();

    expect(unwrapped).toBe(2);
    expect(retry).toBeTruthy();
    await expect(runKiroPreToolUseHook(kiroEvent(retry!))).resolves.toBe(0);
  });

  it("fails closed for malformed shell hook input", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runKiroPreToolUseHook("not-json")).resolves.toBe(2);
    await expect(runKiroPreToolUseHook(JSON.stringify({
      hook_event_name: "preToolUse",
      tool_name: "shell",
      tool_input: {},
    }))).resolves.toBe(2);
  });

  it("ignores non-shell tools and non-PreToolUse events", async () => {
    const nonShell = await runKiroPreToolUseHook(kiroEvent("anything", "read"));
    const postTool = await runKiroPreToolUseHook(JSON.stringify({
      hook_event_name: "postToolUse",
      tool_name: "shell",
      tool_input: { command: "pnpm test" },
    }));

    expect(nonShell).toBe(0);
    expect(postTool).toBe(0);
  });
});

describe("kiro steering compatibility", () => {
  it("installs and diagnoses the always-included companion steering", async () => {
    const projectDir = await createTempDir();
    const steeringPath = join(projectDir, ".kiro", "steering", "tokenjuice.md");

    const result = await installKiroSteering(steeringPath);
    const doctor = await doctorKiroSteering(steeringPath);

    expect(result.steeringPath).toBe(steeringPath);
    expect(doctor.status).toBe("ok");
  });

  it("uses KIRO_PROJECT_DIR for steering install and uninstall", async () => {
    const projectDir = await createTempDir();
    process.env.KIRO_PROJECT_DIR = projectDir;

    const installed = await installKiroSteering();
    const removed = await uninstallKiroSteering();

    expect(installed.steeringPath).toBe(join(projectDir, ".kiro", "steering", "tokenjuice.md"));
    expect(removed.removed).toBe(true);
  });

  it("does not remove markerless user-owned steering files", async () => {
    const projectDir = await createTempDir();
    const steeringPath = join(projectDir, ".kiro", "steering", "tokenjuice.md");
    await mkdir(join(projectDir, ".kiro", "steering"), { recursive: true });
    await writeFile(steeringPath, "# user Kiro steering\n", "utf8");

    const removed = await uninstallKiroSteering(undefined, { projectDir });

    expect(removed.removed).toBe(false);
    await expect(readFile(steeringPath, "utf8")).resolves.toBe("# user Kiro steering\n");
  });
});
