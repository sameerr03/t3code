import { useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import { useEffect } from "react";

import {
  loadThreadLastVisitedAtByKey,
  saveThreadLastVisitedAt,
  type ThreadLastVisitedAtByKey,
} from "../persistence/imperative";
import { appAtomRegistry } from "./atom-registry";
import { mergeThreadVisits, recordThreadVisit } from "./thread-visits.logic";

interface ThreadVisitsState {
  readonly loaded: boolean;
  readonly visits: ThreadLastVisitedAtByKey;
}

const threadVisitsAtom = Atom.make<ThreadVisitsState>({ loaded: false, visits: {} }).pipe(
  Atom.keepAlive,
);

let loadPromise: Promise<void> | null = null;

function ensureThreadVisitsLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = loadThreadLastVisitedAtByKey()
    .then((persisted) => {
      const current = appAtomRegistry.get(threadVisitsAtom);
      appAtomRegistry.set(threadVisitsAtom, {
        loaded: true,
        visits: mergeThreadVisits(persisted, current.visits),
      });
    })
    .catch((error) => {
      console.warn("[thread-visits] failed to load visit watermarks", error);
      const current = appAtomRegistry.get(threadVisitsAtom);
      appAtomRegistry.set(threadVisitsAtom, { ...current, loaded: true });
    });
  return loadPromise;
}

export function markThreadVisited(threadKey: string, visitedAt: string): void {
  void ensureThreadVisitsLoaded().then(() => {
    const current = appAtomRegistry.get(threadVisitsAtom);
    const visits = recordThreadVisit(current.visits, threadKey, visitedAt);
    if (visits === current.visits) return;

    appAtomRegistry.set(threadVisitsAtom, { loaded: true, visits });
    void saveThreadLastVisitedAt(threadKey, visitedAt).catch((error) => {
      console.warn("[thread-visits] failed to persist visit watermark", error);
    });
  });
}

export function useThreadLastVisitedAtByKey(): ThreadLastVisitedAtByKey {
  const state = useAtomValue(threadVisitsAtom);
  useEffect(() => {
    void ensureThreadVisitsLoaded();
  }, []);
  return state.visits;
}
