const PAUSED_ATTRIBUTE = "data-skeleton-paused";
const RESUME_DELAY_MS = 300;
const EVENTS = [
  "pointerdown",
  "pointerup",
  "keydown",
  "input",
  "wheel",
  "scroll",
] as const;

interface InteractionController {
  register: (table: HTMLTableElement) => () => void;
}

const controllers = new WeakMap<Document, InteractionController>();

function createController(document: Document): InteractionController {
  const view = document.defaultView;
  const tables = new Set<HTMLTableElement>();
  let paused = false;
  let lastInteraction = 0;
  let timer: number | undefined;
  let idle: number | undefined;

  const setPaused = (value: boolean) => {
    if (paused === value) return;
    paused = value;
    for (const table of tables) table.toggleAttribute(PAUSED_ATTRIBUTE, value);
  };
  const clearScheduled = () => {
    if (timer !== undefined) view?.clearTimeout(timer);
    if (idle !== undefined) view?.cancelIdleCallback(idle);
    timer = undefined;
    idle = undefined;
  };
  const resume = () => {
    timer = undefined;
    if (!view || !tables.size) return;
    const remaining =
      RESUME_DELAY_MS - (view.performance.now() - lastInteraction);
    if (remaining > 0) {
      timer = view.setTimeout(resume, remaining);
      return;
    }
    if (document.hidden) return;
    if (typeof view.requestIdleCallback === "function") {
      idle = view.requestIdleCallback((deadline) => {
        idle = undefined;
        if (deadline.timeRemaining() < 5) {
          timer = view.setTimeout(resume, 32);
          return;
        }
        if (
          view.performance.now() - lastInteraction >= RESUME_DELAY_MS &&
          !document.hidden
        ) {
          setPaused(false);
        } else {
          resume();
        }
      });
    } else {
      setPaused(false);
    }
  };
  const interact = () => {
    if (!view) return;
    lastInteraction = view.performance.now();
    setPaused(true);
    // High frequency scroll/wheel events only update the timestamp.
    if (idle !== undefined) {
      view.cancelIdleCallback(idle);
      idle = undefined;
    }
    if (timer === undefined) timer = view.setTimeout(resume, RESUME_DELAY_MS);
  };
  const visibilityChanged = () => {
    if (document.hidden) {
      clearScheduled();
      setPaused(true);
    } else {
      interact();
    }
  };

  return {
    register(table) {
      if (!view) return () => {};
      if (tables.size === 0) {
        for (const event of EVENTS)
          document.addEventListener(event, interact, {
            capture: true,
            passive: true,
          });
        document.addEventListener("visibilitychange", visibilityChanged);
        paused = document.hidden;
      }
      tables.add(table);
      table.toggleAttribute(PAUSED_ATTRIBUTE, paused);
      return () => {
        tables.delete(table);
        table.removeAttribute(PAUSED_ATTRIBUTE);
        if (tables.size) return;
        clearScheduled();
        for (const event of EVENTS)
          document.removeEventListener(event, interact, true);
        document.removeEventListener("visibilitychange", visibilityChanged);
        paused = false;
      };
    },
  };
}

/** One event subscription per document, only while skeleton rows exist. */
export function registerSkeletonInteraction(
  table: HTMLTableElement,
): () => void {
  const document = table.ownerDocument;
  let controller = controllers.get(document);
  if (!controller) {
    controller = createController(document);
    controllers.set(document, controller);
  }
  return controller.register(table);
}
