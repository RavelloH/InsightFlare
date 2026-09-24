import { describe, expect, it } from "vitest";

import { findSiteProfile } from "@/lib/demo/data/site-profiles";
import { mulberry32 } from "@/lib/demo/generators/utils";
import {
  buildPathTransitionGraph,
  nextPath,
} from "@/lib/demo/realtime/path-markov";
const rng = (seed: number) => mulberry32(seed);
describe("mock/path-markov", () => {
  describe("buildPathTransitionGraph", () => {
    it("uses paths[0] as the entry node", () => {
      const profile = findSiteProfile("demo-site-001");
      const graph = buildPathTransitionGraph(profile);
      expect(graph.entry).toBe(profile.paths[0]);
    });

    it("appends extra paths to the universe", () => {
      const profile = findSiteProfile("demo-site-001");
      const extras = ["/extra-1", "/extra-2"];
      const graph = buildPathTransitionGraph(profile, extras);
      expect(graph.paths).toEqual(expect.arrayContaining(extras));
    });

    it("returns a cached graph when called with the same key", () => {
      const profile = findSiteProfile("demo-site-002");
      const graph1 = buildPathTransitionGraph(profile, []);
      const graph2 = buildPathTransitionGraph(profile, []);
      expect(graph1).toBe(graph2);
    });

    it("respects explicit pathFlow overrides", () => {
      const profile = {
        ...findSiteProfile("demo-site-001"),
        id: "test-pathflow-1",
        paths: ["/", "/a", "/b"],
        pathFlow: {
          "/a": [{ to: "/b", weight: 1 }],
        },
      };
      const graph = buildPathTransitionGraph(profile);
      const edges = graph.nodes.get("/a");
      expect(edges).toEqual([{ to: "/b", weight: 1 }]);
    });

    it("falls back to default edges for paths missing from pathFlow", () => {
      const profile = {
        ...findSiteProfile("demo-site-001"),
        id: "test-pathflow-2",
        paths: ["/", "/a", "/b"],
        pathFlow: {
          "/a": [{ to: "/b", weight: 1 }],
        },
      };
      const graph = buildPathTransitionGraph(profile);
      // "/" not in pathFlow, gets default edges
      expect(graph.nodes.get("/")).toBeDefined();
      expect((graph.nodes.get("/") ?? []).length).toBeGreaterThan(0);
    });

    it("ignores pathFlow edges with zero/negative weight", () => {
      const profile = {
        ...findSiteProfile("demo-site-001"),
        id: "test-pathflow-3",
        paths: ["/", "/a"],
        pathFlow: {
          "/a": [
            { to: "/", weight: 0 },
            { to: "/b", weight: -1 },
          ],
        },
      };
      const graph = buildPathTransitionGraph(profile);
      // All explicit edges have weight ≤ 0, so default edges should kick in.
      const edges = graph.nodes.get("/a") ?? [];
      expect(edges.length).toBeGreaterThan(0);
    });

    it("normalizes sparse paths, extra paths, and pathFlow fallbacks", () => {
      const profile = {
        ...findSiteProfile("demo-site-001"),
        id: "test-pathflow-normalization",
        paths: ["", " / ", "/a//b/", "/a/b"],
        pathFlow: {
          invalid: [
            { to: "also-invalid", weight: "2" },
            { to: "/kept//target/", weight: "3.5" },
            { to: "/ignored", weight: Number.NaN },
          ],
        },
      } as unknown as Parameters<typeof buildPathTransitionGraph>[0];

      const graph = buildPathTransitionGraph(profile, [
        "/a/b",
        "missing-leading-slash",
        "/extra//path/",
        "",
      ]);

      expect(graph.entry).toBe("/");
      expect(graph.paths).toEqual(["/", "/a/b", "/extra/path"]);
      expect(graph.nodes.get("/")).toEqual([
        { to: "/", weight: 2 },
        { to: "/kept/target", weight: 3.5 },
      ]);
      expect(graph.nodes.get("/a/b")).toEqual(
        expect.arrayContaining([{ to: "/", weight: expect.any(Number) }]),
      );
    });

    it("falls back to the root entry when a profile has no paths", () => {
      const profile = {
        ...findSiteProfile("demo-site-001"),
        id: "test-empty-paths",
        paths: [],
      };

      const graph = buildPathTransitionGraph(profile);

      expect(graph.entry).toBe("/");
      expect(graph.paths).toEqual([]);
      expect(graph.nodes.size).toBe(0);
    });

    it("clears the graph cache after it grows past the cap", () => {
      const profile = findSiteProfile("demo-site-001");
      const first = buildPathTransitionGraph({
        ...profile,
        id: "test-cache-first",
      });

      for (let index = 0; index < 62; index += 1) {
        buildPathTransitionGraph({
          ...profile,
          id: `test-cache-fill-${index}`,
        });
      }

      const rebuilt = buildPathTransitionGraph({
        ...profile,
        id: "test-cache-first",
      });
      expect(rebuilt).not.toBe(first);
    });
  });

  describe("nextPath", () => {
    it("returns the entry node when current path is empty", () => {
      const profile = findSiteProfile("demo-site-001");
      const graph = buildPathTransitionGraph(profile);
      expect(nextPath(graph, "", rng(1))).toBe(graph.entry);
    });

    it("returns the current path for stay picks and entry for home picks", () => {
      const profile = findSiteProfile("demo-site-001");
      const graph = buildPathTransitionGraph(profile);

      expect(nextPath(graph, "/about", () => 0.01)).toBe("/about");
      expect(nextPath(graph, "/about", () => 0.08)).toBe(graph.entry);
    });

    it("returns the entry node when current path has no edges", () => {
      const profile = findSiteProfile("demo-site-001");
      const graph = buildPathTransitionGraph(profile);
      // Drive rng to skip the STAY/HOME shortcuts; we just need something
      // that picks the fallback when no edges exist.
      const next = nextPath(graph, "/unknown-path-xyz", rng(11));
      expect(typeof next).toBe("string");
      expect(next.length).toBeGreaterThan(0);
    });

    it("can return the current path (STAY) or entry (HOME)", () => {
      const profile = findSiteProfile("demo-site-001");
      const graph = buildPathTransitionGraph(profile);
      const r = rng(7);
      const seen = new Set<string>();
      for (let i = 0; i < 80; i += 1) {
        seen.add(nextPath(graph, "/about", r));
      }
      // At minimum, multiple distinct targets reached over many runs.
      expect(seen.size).toBeGreaterThan(1);
    });

    it("returns one of the universe paths", () => {
      const profile = findSiteProfile("demo-site-002");
      const graph = buildPathTransitionGraph(profile);
      const r = rng(13);
      const universe = new Set([graph.entry, ...graph.paths]);
      for (let i = 0; i < 30; i += 1) {
        const next = nextPath(graph, "/", r);
        expect(universe.has(next)).toBe(true);
      }
    });

    it("falls back to the entry when an explicit graph has no reachable edges", () => {
      expect(
        nextPath(
          { entry: "/", nodes: new Map(), paths: [] },
          "/missing",
          () => 0.5,
        ),
      ).toBe("/");
      expect(
        nextPath(
          {
            entry: "/",
            nodes: new Map([["/", [{ to: "/target", weight: 0 }]]]),
            paths: ["/", "/target"],
          },
          "/missing",
          () => 0.5,
        ),
      ).toBe("/target");
    });
  });
});
