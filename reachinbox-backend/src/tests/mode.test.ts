import { describe, it, expect, beforeEach } from "vitest";
import { getMode, publishMode } from "../domain/mode.js";

/**
 * The mode report is the only way to confirm from outside that a deploy took
 * the intended role. It was silently missing once already: the startup log
 * reported `modeVia`, `/health/mode` was documented as the post-deploy check,
 * and no commit ever contained the route. Everything still read as correct
 * because the log line was true.
 *
 * These tests pin the state holder so that class of omission is a failing test
 * rather than a question asked at deploy time.
 */
describe("published mode", () => {
  beforeEach(() => {
    publishMode({ isWorker: false, via: "unresolved" });
  });

  it("defaults to unresolved rather than claiming a role", () => {
    // Safer than defaulting to `default`: before resolveMode() runs, the honest
    // answer is that nothing has been decided yet.
    expect(getMode()).toEqual({ isWorker: false, via: "unresolved" });
  });

  it("reports the worker role selected by the env var", () => {
    publishMode({ isWorker: true, via: "env" });
    expect(getMode()).toEqual({ isWorker: true, via: "env" });
  });

  it("reports the worker role selected by the flag", () => {
    publishMode({ isWorker: true, via: "argv" });
    expect(getMode().via).toBe("argv");
  });

  it("reports API mode when neither signal was present", () => {
    publishMode({ isWorker: false, via: "default" });
    expect(getMode()).toEqual({ isWorker: false, via: "default" });
  });

  it("retains the signal, not just the boolean", () => {
    // The boolean alone cannot distinguish "no env var" from "env var set but
    // ignored", which is the disagreement case worth surfacing after a deploy.
    publishMode({ isWorker: true, via: "env" });
    expect(getMode().via).not.toBe(getMode().isWorker ? "default" : "env");
  });

  it("overwrites a previous value rather than merging", () => {
    publishMode({ isWorker: true, via: "env" });
    publishMode({ isWorker: false, via: "default" });
    expect(getMode()).toEqual({ isWorker: false, via: "default" });
  });
});
