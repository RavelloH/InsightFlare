import { describe, expect, it } from "vitest";

import {
  getScheduledTaskDefinition,
  SCHEDULED_TASKS,
} from "@/lib/edge/scheduled-tasks/registry";
describe("edge/scheduled-task-registry", () => {
  describe("SCHEDULED_TASKS", () => {
    it("is a non-empty array of task definitions", () => {
      expect(Array.isArray(SCHEDULED_TASKS)).toBe(true);
      expect(SCHEDULED_TASKS.length).toBeGreaterThan(0);
    });

    it("each entry has all required fields with correct types", () => {
      for (const task of SCHEDULED_TASKS) {
        expect(typeof task.key).toBe("string");
        expect(task.key.length).toBeGreaterThan(0);
        expect(typeof task.name).toBe("string");
        expect(task.name.length).toBeGreaterThan(0);
        expect(typeof task.description).toBe("string");
        expect(typeof task.schedule).toBe("string");
        expect(["cron", "manual", "event"]).toContain(task.trigger);
        expect(typeof task.enabled).toBe("boolean");
      }
    });

    it("has unique keys for all tasks", () => {
      const keys = SCHEDULED_TASKS.map((t) => t.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("includes the visit_hourly_rollup task", () => {
      const task = SCHEDULED_TASKS.find((t) => t.key === "visit_hourly_rollup");
      expect(task).toBeDefined();
      expect(task!.enabled).toBe(true);
      expect(task!.trigger).toBe("cron");
    });

    it("includes the notification_tick task as enabled", () => {
      const task = SCHEDULED_TASKS.find((t) => t.key === "notification_tick");
      expect(task).toBeDefined();
      expect(task!.enabled).toBe(true);
      expect(task!.trigger).toBe("cron");
    });
  });

  describe("getScheduledTaskDefinition", () => {
    it("returns the task when the key matches", () => {
      const task = getScheduledTaskDefinition("visit_hourly_rollup");
      expect(task).not.toBeNull();
      expect(task!.key).toBe("visit_hourly_rollup");
      expect(task!.name).toBe("Hourly visit aggregation");
    });

    it("returns null for an unknown key", () => {
      expect(getScheduledTaskDefinition("nonexistent")).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(getScheduledTaskDefinition("")).toBeNull();
    });

    it("is case-sensitive", () => {
      expect(getScheduledTaskDefinition("Visit_Hourly_Rollup")).toBeNull();
    });

    it("returns the same reference as the SCHEDULED_TASKS array entry", () => {
      const task = getScheduledTaskDefinition("visit_hourly_rollup");
      const fromArray = SCHEDULED_TASKS.find(
        (t) => t.key === "visit_hourly_rollup",
      );
      expect(task).toBe(fromArray);
    });
  });
});
