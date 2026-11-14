const DEMO_FRAME_ANCESTORS = [
  "'self'",
  "https://insightflare.net",
  "https://www.insightflare.net",
  "http://localhost:*",
  "http://127.0.0.1:*",
];

export interface FramePolicy {
  frameOptions: string | null;
  frameAncestors: string;
}

// Only the public demo deployment may be framed (by the project website).
export function framePolicy(demoMode: boolean): FramePolicy {
  if (!demoMode) {
    return { frameOptions: "DENY", frameAncestors: "'none'" };
  }
  return {
    frameOptions: null,
    frameAncestors: DEMO_FRAME_ANCESTORS.join(" "),
  };
}
