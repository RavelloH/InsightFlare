import { buildDemoFactDataset } from "@/lib/realtime/mock/fact-builder";
import type { DemoFactDataset } from "@/lib/realtime/mock/types";

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
