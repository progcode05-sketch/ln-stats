import { EventEmitter } from "node:events";

export type JobPhase = "idle" | "starting" | "connecting" | "collecting" | "done" | "error";

export interface JobProgress {
  current: number;
  total: number;
  message: string;
}

export interface JobState {
  userId: string;
  phase: JobPhase;
  progress: JobProgress | null;
  error: string | null;
  collectionId: number | null;
  updatedAt: number;
}

const jobs = new Map<string, JobState>();
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function emit(userId: string): void {
  emitter.emit(`update:${userId}`, getJob(userId));
}

export function getJob(userId: string): JobState {
  return (
    jobs.get(userId) ?? {
      userId,
      phase: "idle",
      progress: null,
      error: null,
      collectionId: null,
      updatedAt: Date.now()
    }
  );
}

export function isRunning(userId: string): boolean {
  const phase = getJob(userId).phase;
  return phase === "starting" || phase === "connecting" || phase === "collecting";
}

// Returns false if a job is already running for this user.
export function startJob(userId: string): boolean {
  if (isRunning(userId)) return false;
  jobs.set(userId, {
    userId,
    phase: "starting",
    progress: { current: 0, total: 0, message: "Starting…" },
    error: null,
    collectionId: null,
    updatedAt: Date.now()
  });
  emit(userId);
  return true;
}

export function updateJob(userId: string, patch: Partial<Omit<JobState, "userId">>): void {
  const current = getJob(userId);
  jobs.set(userId, { ...current, ...patch, updatedAt: Date.now() });
  emit(userId);
}

export function subscribe(userId: string, listener: (state: JobState) => void): () => void {
  const event = `update:${userId}`;
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}
