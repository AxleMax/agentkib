import { create } from "zustand";
import { api } from "@/core/api";
import type { RemoteRequest, RemoteStatus, RemotePairingResult } from "@/core/remote-types";

type Operation = Exclude<RemoteRequest, { operation: "catalog" | "events" | "status" }>;
type RemoteState = {
  snapshot: RemoteStatus | null;
  pairing: RemotePairingResult | null;
  loading: boolean;
  busy: boolean;
  error: unknown;
  operationError: boolean;
  clearError: () => void;
  refresh: () => Promise<void>;
  run: (request: Operation) => Promise<RemoteStatus | RemotePairingResult | null>;
};

// A mutation invalidates status reads already in flight, including reads from another panel.
let revision = 0;
export const useRemoteStore = create<RemoteState>((set, get) => ({
  snapshot: null,
  pairing: null,
  loading: false,
  busy: false,
  error: "",
  operationError: false,
  clearError: () => set({ error: "", operationError: false }),
  refresh: async () => {
    if (get().loading || get().busy) return;
    const ticket = revision;
    set({ loading: true });
    try {
      const snapshot = await api.remoteRequest({ operation: "status" });
      if (ticket === revision) set({ snapshot, error: get().operationError ? get().error : "" });
    } catch (error) {
      if (ticket === revision && !get().operationError) set({ error });
    } finally {
      if (ticket === revision) set({ loading: false });
    }
  },
  run: async (request) => {
    if (get().busy) return null;
    const ticket = ++revision;
    set({ busy: true, loading: false, error: "", operationError: false });
    try {
      const result = await api.remoteRequest(request);
      if (ticket !== revision) return null;
      if ("local" in result) set({ snapshot: result });
      else set({ pairing: result });
      return result;
    } catch (error) {
      if (ticket === revision) set({ error, operationError: true });
      return null;
    } finally {
      if (ticket === revision) {
        set({ busy: false });
        void get().refresh();
      }
    }
  },
}));
