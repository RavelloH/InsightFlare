import { Skeleton } from "@/components/ui/skeleton";
import type { EventField } from "@/lib/dashboard-api/client/edge";

import { normalizeEventFieldPath } from "./event-model";
import { type EventFieldTreeNode } from "./types";

function createEventFieldTreeNode(
  path: string,
  segment: string,
): EventFieldTreeNode {
  return {
    path,
    segment,
    fields: [],
    children: [],
  };
}

export function buildEventFieldTree(fields: EventField[]): EventFieldTreeNode {
  const root = createEventFieldTreeNode("", "");
  const childMaps = new Map<
    EventFieldTreeNode,
    Map<string, EventFieldTreeNode>
  >();

  const ensureChild = (
    parent: EventFieldTreeNode,
    segment: string,
    path: string,
  ): EventFieldTreeNode => {
    let childMap = childMaps.get(parent);
    if (!childMap) {
      childMap = new Map();
      childMaps.set(parent, childMap);
    }
    const existing = childMap.get(segment);
    if (existing) return existing;
    const child = createEventFieldTreeNode(path, segment);
    childMap.set(segment, child);
    parent.children.push(child);
    return child;
  };

  for (const field of fields) {
    const normalizedPath = normalizeEventFieldPath(field.path);
    if (!normalizedPath) {
      root.fields.push(field);
      continue;
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    let parent = root;
    let currentPath = "";
    for (const segment of segments) {
      currentPath = `${currentPath}/${segment}`;
      parent = ensureChild(parent, segment, currentPath);
    }
    parent.fields.push(field);
  }

  return root;
}

export function collectEventFieldTreeExpansionKeys(
  node: EventFieldTreeNode,
  keys = new Set<string>(),
): Set<string> {
  if (node.children.length > 0 || node.path === "") {
    keys.add(node.path || "/");
  }
  for (const child of node.children) {
    collectEventFieldTreeExpansionKeys(child, keys);
  }
  return keys;
}

export function EventFieldTreeSkeleton({
  loadingLabel,
}: {
  loadingLabel: string;
}) {
  const rows = [
    { indent: "pl-0", width: "w-28", branch: true },
    { indent: "pl-5", width: "w-24", branch: true },
    { indent: "pl-10", width: "w-32", branch: false },
    { indent: "pl-10", width: "w-20", branch: false },
    { indent: "pl-5", width: "w-28", branch: true },
    { indent: "pl-10", width: "w-24", branch: false },
  ];

  return (
    <div
      className="space-y-0.5 border border-border/50 bg-muted/10 px-2 py-2"
      aria-busy="true"
      aria-label={loadingLabel}
    >
      {rows.map((row, index) => (
        <div
          key={index}
          className={`flex h-8 items-center gap-2 ${row.indent}`}
        >
          <Skeleton className="size-6 shrink-0 rounded-none" />
          <Skeleton className={`h-3.5 ${row.width} rounded-none`} />
          {row.branch ? (
            <Skeleton className="ml-auto size-5 shrink-0 rounded-none" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function formatEventFieldKeySegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
