/**
 * Known agent harnesses sparkDash can set up for VulnHunter with one click. A preset is a fixed,
 * server-side description: which CLI to look for, where its skills live, and the tiny wrapper script
 * that turns "prompt FILE as the last argument" (VulnHunter's contract) into that CLI's headless call.
 * Nothing in a preset comes from a request; the request only names a preset id.
 *
 * The flags were checked against each CLI's own `--help`. Whether a given harness resolves the
 * `/vulnhunt` skill invocation in headless mode is up to the harness and is not verified here.
 *
 * `$SPARKDASH_VULNHUNT_RO` ("1" read-only requested, "0" may execute code) is exported by the scan
 * wrapper. Where the CLI can restrict its tools (`roEnforced`), read-only is enforced by the harness
 * itself, not only requested in the prompt.
 */

/** @typedef {{ id: string, label: string, bin: string, skillsDir: string, agentsDir: string, roEnforced: boolean, note: string, body: string }} HarnessPreset */

/** @type {readonly HarnessPreset[]} */
export const HARNESS_PRESETS = Object.freeze([
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    skillsDir: "~/.claude/skills",
    agentsDir: "~/.claude/agents",
    roEnforced: true,
    note: "Read-only scans are limited to the Read, Grep, Glob, Task, Write and Edit tools (no shell). Scans that may execute code run without permission prompts.",
    body: `if [ "\${SPARKDASH_VULNHUNT_RO:-1}" = 1 ]; then
  exec "$BIN" -p "$PROMPT" --allowedTools Read Grep Glob Task Write Edit
else
  exec "$BIN" -p "$PROMPT" --dangerously-skip-permissions
fi`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    skillsDir: "~/.codex/skills",
    agentsDir: "",
    roEnforced: true,
    note: "Read-only scans run in Codex's workspace-write sandbox (no network, writes limited to the checkout). Scans that may execute code run without the sandbox.",
    body: `if [ "\${SPARKDASH_VULNHUNT_RO:-1}" = 1 ]; then
  exec "$BIN" exec --skip-git-repo-check -s workspace-write "$PROMPT"
else
  exec "$BIN" exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$PROMPT"
fi`,
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    skillsDir: "~/.config/opencode/skills",
    agentsDir: "",
    roEnforced: false,
    note: "Runs `opencode run` with the prompt. Read-only is only requested in the prompt; OpenCode's own permission settings apply.",
    body: `exec "$BIN" run "$PROMPT"`,
  },
]);

const BY_ID = new Map(HARNESS_PRESETS.map((p) => [p.id, p]));

export function harnessById(id) {
  return typeof id === "string" ? BY_ID.get(id) ?? null : null;
}

/** The wrapper script; `@BIN@` is replaced on the unit with the CLI's absolute path. */
export function wrapperScript(preset) {
  return `#!/bin/sh
# sparkdash-managed: runs ${preset.label} headlessly on the prompt FILE given as the last argument.
BIN='@BIN@'
PROMPT=$(cat "$1") || exit 2
${preset.body}
`;
}

/** Name of the wrapper in ~/.local/bin. */
export const wrapperName = (preset) => `vulnhunt-${preset.id}`;
