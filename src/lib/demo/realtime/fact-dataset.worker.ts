import { buildDemoFactDataset } from "@/lib/demo/realtime/fact-builder";
import type { DemoFactDataset } from "@/lib/demo/realtime/types";

interface BuildFactDatasetMessage {
  type: "build";
  siteId: string;
  from: number;
  to: number;
}

export type DemoFactDatasetWorkerMessage =
  | { type: "ready"; dataset: DemoFactDataset }
  | { type: "error"; message: string };

const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<BuildFactDatasetMessage>) => void;
  postMessage: (message: DemoFactDatasetWorkerMessage) => void;
};

workerScope.onmessage = ({ data }) => {
  try {
    workerScope.postMessage({
      type: "ready",
      dataset: buildDemoFactDataset(data.siteId, data.from, data.to),
    });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
