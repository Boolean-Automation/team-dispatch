// dispatch — useUndoableMutation: TanStack Query mutation wrapper
//
// Every mutating API call that returns an { undoToken } should go through
// this wrapper. On success it fires an Undo toast that calls POST /api/undo.
//
// plan §Slice 4 / A25

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MutationOptions } from "@tanstack/react-query";

// Toast event bus — web-only, no core dependency
// Components subscribe to this to show the UndoToast
type UndoToastHandler = (token: string, label: string) => void;

let _undoToastHandler: UndoToastHandler | null = null;

export function registerUndoToastHandler(handler: UndoToastHandler): void {
  _undoToastHandler = handler;
}

function fireUndoToast(token: string, label: string): void {
  if (_undoToastHandler) {
    _undoToastHandler(token, label);
  }
}

// ── Undo API call ─────────────────────────────────────────────────────────────

async function postUndo(token: string): Promise<void> {
  const res = await fetch("/api/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    throw new Error(`Undo failed: ${res.status}`);
  }
}

// ── useUndoableMutation ───────────────────────────────────────────────────────

export interface UndoableMutationOptions<TData, TVariables> {
  /** Async function that calls the API and returns data with an optional undoToken */
  mutationFn: (variables: TVariables) => Promise<TData & { undoToken?: string }>;
  /** Label shown in the undo toast, e.g. "Ticket created" */
  toastLabel: string;
  /** Query keys to invalidate on success */
  invalidateKeys?: string[][];
  /** Optional extra onSuccess callback */
  onSuccess?: (data: TData, variables: TVariables) => void;
}

export function useUndoableMutation<TData, TVariables>(
  opts: UndoableMutationOptions<TData, TVariables>
): ReturnType<typeof useMutation<TData & { undoToken?: string }, Error, TVariables>> {
  const queryClient = useQueryClient();

  const mutationOpts: MutationOptions<
    TData & { undoToken?: string },
    Error,
    TVariables
  > = {
    mutationFn: opts.mutationFn,
    onSuccess: (data, variables) => {
      // Invalidate query caches
      if (opts.invalidateKeys) {
        for (const key of opts.invalidateKeys) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }

      // Fire undo toast if the response includes a token
      if (data.undoToken) {
        fireUndoToast(data.undoToken, opts.toastLabel);
      }

      // Call extra success handler
      opts.onSuccess?.(data, variables);
    },
  };

  return useMutation(mutationOpts);
}
