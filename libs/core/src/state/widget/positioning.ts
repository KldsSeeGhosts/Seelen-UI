import { Alignment, type Frame, type PhysicalMonitor } from "@seelen-ui/types";
import { invoke, subscribe } from "../../handlers/mod.ts";
import { SeelenCommand } from "../../handlers/commands.ts";
import { SeelenEvent } from "../../handlers/events.ts";

interface args {
  frame: Frame;
  originX?: Alignment | null;
  originY?: Alignment | null;
}

const monitors = {
  value: [] as PhysicalMonitor[],
};

export async function initMonitorsState(): Promise<void> {
  monitors.value = await invoke(SeelenCommand.SystemGetMonitors);
  subscribe(SeelenEvent.SystemMonitorsChanged, ({ payload }) => {
    monitors.value = payload;
  });
}

function distanceToMonitor(x: number, y: number, { rect }: PhysicalMonitor): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Monitor containing the point or, when the point is outside of every monitor
 * (e.g. it is off-screen), the closest one to it.
 */
function monitorFromPoint(x: number, y: number): PhysicalMonitor | undefined {
  let nearest: PhysicalMonitor | undefined;
  let nearestDistance = Infinity;

  for (const monitor of monitors.value) {
    const { rect } = monitor;
    if (rect.left <= x && x < rect.right && rect.top <= y && y < rect.bottom) {
      return monitor;
    }

    const distance = distanceToMonitor(x, y, monitor);
    if (distance < nearestDistance) {
      nearest = monitor;
      nearestDistance = distance;
    }
  }

  return nearest;
}

export function adjustPositionByPlacement({
  frame: { x, y, width, height },
  originX,
  originY,
}: args): Frame {
  // The monitor must be resolved from the anchor point, before the alignment moves
  // the top-left corner of the frame, otherwise popups anchored near the edge of a
  // monitor get clamped into the neighbour one.
  const monitor = monitorFromPoint(Math.round(x), Math.round(y));

  if (originX === Alignment.Center) {
    x -= width / 2;
  } else if (originX === Alignment.End) {
    x -= width;
  }

  if (originY === Alignment.Center) {
    y -= height / 2;
  } else if (originY === Alignment.End) {
    y -= height;
  }

  const newFrame = fitIntoMonitor({ x, y, width, height }, monitor);
  return {
    x: Math.round(newFrame.x),
    y: Math.round(newFrame.y),
    width: Math.round(newFrame.width),
    height: Math.round(newFrame.height),
  };
}

/**
 * Clamps the frame into the given monitor. When no monitor is given, the one
 * containing the centre of the frame (or the closest to it) is used.
 */
export function fitIntoMonitor({ x, y, width, height }: Frame, monitor?: PhysicalMonitor): Frame {
  monitor ||= monitorFromPoint(Math.round(x + width / 2), Math.round(y + height / 2));
  if (monitor) {
    width = Math.min(width, monitor.rect.right - monitor.rect.left);
    height = Math.min(height, monitor.rect.bottom - monitor.rect.top);

    const x2 = x + width;
    const y2 = y + height;

    // check left edge
    if (x < monitor.rect.left) {
      x = monitor.rect.left;
    }

    // check top edge
    if (y < monitor.rect.top) {
      y = monitor.rect.top;
    }

    // check right edge
    if (x2 > monitor.rect.right) {
      x = monitor.rect.right - width;
    }

    // check bottom edge
    if (y2 > monitor.rect.bottom) {
      y = monitor.rect.bottom - height;
    }
  }

  return {
    x,
    y,
    width,
    height,
  };
}
