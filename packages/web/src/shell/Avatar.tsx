// dispatch — Avatar component
// Ported from shell.jsx Avatar function.

import React from "react";
import { ENGINEERS } from "../lib/seed";

interface AvatarProps {
  /** Clerk user id / engineer key, or null/undefined for unassigned */
  engKey: string | null | undefined;
  /** Pixel size — default 18 */
  size?: number;
  /** Accessible label override (used for contact avatars in cards) */
  alt?: string;
}

export function Avatar({ engKey, size = 18, alt }: AvatarProps) {
  const fontSize = Math.round(size * 0.5);

  if (!engKey) {
    const label = alt ?? "Unassigned";
    return (
      <span
        className="avatar unassigned"
        style={{ width: size, height: size, fontSize }}
        title={label}
        aria-label={label}
        role="img"
      >
        ?
      </span>
    );
  }

  const e = ENGINEERS[engKey];
  if (!e) {
    // Unknown key — render a grey placeholder
    const label = alt ?? "Contact avatar";
    return (
      <span
        className="avatar"
        style={{
          background: "#475569",
          width: size,
          height: size,
          fontSize,
        }}
        title={label}
        aria-label={label}
        role="img"
      >
        ?
      </span>
    );
  }

  const label = alt ?? e.name;
  return (
    <span
      className="avatar"
      title={label}
      aria-label={label}
      role="img"
      style={{ background: e.color, width: size, height: size, fontSize }}
    >
      {e.initials[0]}
    </span>
  );
}
