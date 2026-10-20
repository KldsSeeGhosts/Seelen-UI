import { invoke, SeelenCommand, SeelenEvent, subscribe } from "@seelen-ui/lib";
import { FolderType, type UserFolderSnapshot } from "@seelen-ui/lib/types";

export type FolderLoadStatus = "idle" | "loading" | "ready" | "error";

export interface FolderItem {
  path: string;
  displayName: string;
}

export interface FolderState {
  status: FolderLoadStatus;
  content: FolderItem[];
}

export interface FolderDefinition {
  type: FolderType;
  icon: string;
}

export const folderDefinitions: FolderDefinition[] = [
  { type: FolderType.Recent, icon: "MdOutlineHistory" },
  { type: FolderType.Desktop, icon: "HiOutlineDesktopComputer" },
  { type: FolderType.Downloads, icon: "PiDownloadSimpleBold" },
  { type: FolderType.Documents, icon: "IoDocumentsOutline" },
  { type: FolderType.Music, icon: "BsFileEarmarkMusic" },
  { type: FolderType.Pictures, icon: "IoImageOutline" },
  { type: FolderType.Videos, icon: "PiVideo" },
];

function createInitialStates(): Record<FolderType, FolderState> {
  const states = {} as Record<FolderType, FolderState>;
  for (const { type } of folderDefinitions) {
    states[type] = { status: "idle", content: [] };
  }
  return states;
}

const folderStates = $state(createInitialStates());
/** Incremented by every event and request, so out-of-order responses can be discarded. */
const revisions = new Map<FolderType, number>();

let subscription: Promise<void> | null = null;

function pathAsItem(path: string): FolderItem {
  return {
    path,
    displayName: path.split(/[\\/]/g).pop() || "",
  };
}

// recent entries are shortcuts, the `.lnk` suffix is noise on the display name
function recentPathAsItem(path: string): FolderItem {
  const item = pathAsItem(path);
  return { ...item, displayName: item.displayName.replace(/\.lnk$/i, "") };
}

function predicate(path: string): boolean {
  const lowercased = path.toLowerCase();
  return !lowercased.endsWith(".ini") && !lowercased.endsWith(".tmp");
}

function formatContent(type: FolderType, content: string[]): FolderItem[] {
  const mapper = type === FolderType.Recent ? recentPathAsItem : pathAsItem;
  return content.filter(predicate).map(mapper);
}

function applyContent(type: FolderType, content: string[]): void {
  const folder = folderStates[type];
  if (!folder) {
    return;
  }
  revisions.set(type, (revisions.get(type) ?? 0) + 1);
  folder.content = formatContent(type, content);
  folder.status = "ready";
}

function ensureSubscription(): Promise<void> {
  subscription ??= subscribe(
    SeelenEvent.UserFolderChanged,
    ({ payload }) => applyContent(payload.ofFolder, payload.content),
  )
    .then(() => undefined)
    .catch((error) => {
      subscription = null;
      throw error;
    });
  return subscription;
}

async function load(type: FolderType): Promise<void> {
  const folder = folderStates[type];
  if (!folder) {
    return;
  }

  const revision = (revisions.get(type) ?? 0) + 1;
  revisions.set(type, revision);
  folder.status = "loading";

  try {
    // Awaiting the acknowledgement guarantees that a background update cannot be missed before the fetch.
    await ensureSubscription();
  } catch (error) {
    console.error(`user-menu: failed to subscribe to folder changes (${type})`, error);
    if (revisions.get(type) === revision) {
      folder.status = "error";
    }
    return;
  }

  try {
    const snapshot: UserFolderSnapshot = await invoke(SeelenCommand.GetUserFolderContentState, {
      folderType: type,
    });
    if (revisions.get(type) !== revision) {
      return; // an event or a newer request already provided the content
    }
    folder.content = formatContent(type, snapshot.content);
    folder.status = snapshot.isLoading ? "loading" : "ready";
  } catch (error) {
    if (revisions.get(type) !== revision) {
      return;
    }
    console.error(`user-menu: failed to load the "${type}" folder`, error);
    folder.status = "error";
  }
}

class KnownFoldersState {
  get(type: FolderType): FolderState {
    return folderStates[type];
  }

  /** Fetches a folder only the first time it is expanded, later expansions reuse its state. */
  ensureLoaded(type: FolderType): void {
    if (folderStates[type].status === "idle") {
      void load(type);
    }
  }

  retry(type: FolderType): void {
    void load(type);
  }
}

export const knownFolders = new KnownFoldersState();
