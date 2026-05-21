// dispatch — UndoToast shell component
//
// Shows an undo toast when a mutation fires an undo token.
// Wires registerUndoToastHandler from use-undoable-mutation.
//
// plan §Slice 4 / A25

import React, { useEffect, useState, useCallback } from "react";
import { registerUndoToastHandler } from "../lib/use-undoable-mutation.js";

interface ToastItem {
  id: string;
  token: string;
  label: string;
  visible: boolean;
}

interface UndoToastProps {
  /** Duration in ms before the toast auto-dismisses. Defaults to 5000. */
  autoDismissMs?: number;
}

async function postUndo(token: string): Promise<void> {
  const res = await fetch("/api/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    console.error(`Undo failed: ${res.status}`);
  }
}

let _toastCounter = 0;

export function UndoToast({ autoDismissMs = 5000 }: UndoToastProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback(
    (token: string, label: string) => {
      const id = `undo-toast-${++_toastCounter}`;
      setToasts((prev) => [...prev, { id, token, label, visible: true }]);

      // Auto-dismiss after the window
      setTimeout(() => {
        setToasts((prev) =>
          prev.map((t) => (t.id === id ? { ...t, visible: false } : t))
        );
        // Remove from DOM after fade
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 300);
      }, autoDismissMs);
    },
    [autoDismissMs]
  );

  useEffect(() => {
    registerUndoToastHandler(addToast);
  }, [addToast]);

  const handleUndo = useCallback(
    async (toast: ToastItem) => {
      // Remove the toast immediately
      setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      // Fire the undo
      await postUndo(toast.token);
    },
    []
  );

  const handleDismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="undo-toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`undo-toast ${toast.visible ? "visible" : "hidden"}`}
          role="status"
        >
          <span className="undo-toast-label">{toast.label}</span>
          <button
            className="undo-toast-btn"
            onClick={() => void handleUndo(toast)}
            aria-label={`Undo: ${toast.label}`}
          >
            Undo
          </button>
          <button
            className="undo-toast-close"
            onClick={() => handleDismiss(toast.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
