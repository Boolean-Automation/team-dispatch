// dispatch — Avatar component
// Ported from shell.jsx Avatar function.

import React from "react";
import { ENGINEERS } from "../lib/seed";

interface AvatarProps {
  /** Clerk user id / engineer key, or null/undefined for unassigned */
  engKey: string | null | undefined;
  /** Pixel size — default 18 */
  size?: number;
}

export function Avatar({ engKey, size = 18 }: AvatarProps) {
  const fontSize = Math.round(size * 0.5);

  if (!engKey) {
    return (
      <span
        className="avatar unassigned"
        style={{ width: size, height: size, fontSize }}
        title="Unassigned"
      >
        ?
      </span>
    );
  }

  const e = ENGINEERS[engKey];
  if (!e) {
    // Unknown key — render a grey placeholder
    return (
      <span
        className="avatar"
        style={{
          background: "#475569",
          width: size,
          height: size,
          fontSize,
        }}
        title={engKey}
      >
        ?
      </span>
    );
  }

  return (
    <span
      className="avatar"
      title={e.name}
      style={{ background: e.color, width: size, height: size, fontSize }}
    >
      {e.initials[0]}
    </span>
  );
}
