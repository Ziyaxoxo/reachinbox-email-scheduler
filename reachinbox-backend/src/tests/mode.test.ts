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
    publishMode({ isWorker: false, servesHttp: true, via: "unresolved" });
  });

  it("defaults to unresolved rather than claiming a role", () => {
    // Safer than defaulting to `default`: before resolveMode() runs, the honest
    // answer is that nothing has been decided yet.
    expect(getMode()).toEqual({ isWorker: false, servesHttp: true, via: "unresolved" });
  });

  it("reports the worker role selected by the env var", () => {
    publishMode({ isWorker: true, servesHttp: false, via: "env" });
    expect(getMode()).toEqual({ isWorker: true, servesHttp: false, via: "env" });
  });

  it("reports the worker role selected by the flag", () => {
    publishMode({ isWorker: true, servesHttp: false, via: "argv" });
    expect(getMode().via).toBe("argv");
  });

  it("reports API mode when neither signal was present", () => {
    publishMode({ isWorker: false, servesHttp: true, via: "default" });
    expect(getMode()).toEqual({ isWorker: false, servesHttp: true, via: "default" });
  });

  it("keeps the roles independent for hybrid mode", () => {
    // Hybrid is the case that broke the boolean: it consumes *and* serves HTTP,
    // so either flag alone reads as a contradiction on a route that plainly
    // responded. This is the free-tier deployment, so it is not a corner case.
    publishMode({ isWorker: true, servesHttp: true, via: "embedded" });
    expect(getMode()).toEqual({ isWorker: true, servesHttp: true, via: "embedded" });
  });

  it("reports hybrid as distinct from a dedicated worker", () => {
    publishMode({ isWorker: true, servesHttp: true, via: "embedded" });
    const hybrid = getMode();
    publishMode({ isWorker: true, servesHttp: false, via: "env" });
    const dedicated = getMode();
    // Both consume. Only one answers HTTP, and that difference is the only
    // thing distinguishing them, so it must not be collapsed.
    expect(hybrid.isWorker).toBe(dedicated.isWorker);
    expect(hybrid.servesHttp).not.toBe(dedicated.servesHttp);
  });

  it("retains the signal, not just the boolean", () => {
    // The flags alone cannot distinguish "no env var" from "env var set but
    // ignored", which is the disagreement case worth surfacing after a deploy.
    publishMode({ isWorker: true, servesHttp: true, via: "embedded" });
    expect(getMode().via).not.toBe(getMode().isWorker ? "default" : "env");
  });

  it("overwrites a previous value rather than merging", () => {
    publishMode({ isWorker: true, servesHttp: false, via: "env" });
    publishMode({ isWorker: false, servesHttp: true, via: "default" });
    expect(getMode()).toEqual({ isWorker: false, servesHttp: true, via: "default" });
  });
});
