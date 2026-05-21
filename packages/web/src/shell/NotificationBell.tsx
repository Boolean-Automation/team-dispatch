// dispatch — NotificationBell shell component
//
// Topbar bell that opens the notification list from GET /api/notifications.
// Polling: checks for unread notifications every 25s (same interval as board).
//
// plan §Slice 4 / spec §3.11

import React, { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Ic from "./Ic.js";
import { apiClient } from "../lib/api-client.js";

interface Notification {
  id: string;
  recipientId: string;
  kind: string;
  ticketId: string | null;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "ticket-assigned":
      return "Ticket assigned to you";
    case "reassignment-incoming":
      return "Reassignment request";
    case "reassignment-accepted":
      return "Reassignment accepted";
    case "reassignment-rejected":
      return "Reassignment rejected";
    case "follow-up-required":
      return "Follow-up required";
    case "closeout-required":
      return "Closeout required";
    case "reinforcement-added":
      return "You were added as reinforcement";
    default:
      return kind;
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

async function markRead(id: string): Promise<void> {
  await fetch(`/api/notifications/${id}/read`, { method: "POST" });
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["notifications"],
    queryFn: () => apiClient.get<Notification[]>("/api/notifications"),
    refetchInterval: 25_000,
    staleTime: 20_000,
  });

  const unread = notifications.filter((n) => !n.readAt);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleOpen = () => {
    setOpen((o) => !o);
  };

  const handleMarkRead = async (id: string) => {
    await markRead(id);
    // The query will refetch automatically on next interval
  };

  return (
    <div className="notification-bell" ref={ref} style={{ position: "relative" }}>
      <button
        className="btn-ghost"
        title="Notifications"
        onClick={handleOpen}
        aria-label={`Notifications${unread.length > 0 ? ` (${unread.length} unread)` : ""}`}
      >
        <Ic.bell />
        {unread.length > 0 && (
          <span className="bell-badge" aria-hidden="true">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </button>

      {open && (
        <div className="notification-dropdown pop" role="dialog" aria-label="Notifications">
          <div className="notification-header">
            <span className="notification-title">Notifications</span>
            {unread.length > 0 && (
              <span className="notification-unread-count">
                {unread.length} unread
              </span>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="notification-empty">No notifications</div>
          ) : (
            <ul className="notification-list">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`notification-item ${n.readAt ? "read" : "unread"}`}
                  onClick={() => {
                    if (!n.readAt) void handleMarkRead(n.id);
                  }}
                >
                  <div className="notification-kind">{kindLabel(n.kind)}</div>
                  {n.ticketId && (
                    <div className="notification-meta">Ticket: {n.ticketId}</div>
                  )}
                  <div className="notification-time">{formatTime(n.createdAt)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
