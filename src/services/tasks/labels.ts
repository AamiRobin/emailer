import type { TaskOrigin } from "./service"

/**
 * Human-facing labels for task provenance (task 5.8, design D6, tasks
 * spec "AI-proposed tasks"): AI-proposed tasks are behaviorally
 * indistinguishable from manual ones and identifiable "by origin in task
 * detail" — the read APIs (getTask/listOpenTasks/listCompletedTasks)
 * already expose `origin` on every Task, and this helper renders it.
 * Consumers are UI surfaces (task 5.7 sidebar rows / a future task
 * detail view); the service itself never calls this.
 */
export function originLabel(origin: TaskOrigin): "Manual" | "From email" | "From AI" {
  switch (origin) {
    case "email":
      return "From email"
    case "ai":
      return "From AI"
    case "manual":
      return "Manual"
  }
}
