export interface HealthStatus {
  status: "ok";
}

/**
 * Deliberately does not touch the database — health checks must succeed
 * even when MongoDB is unreachable, so orchestration tooling can tell the
 * process is alive independent of downstream dependencies.
 */
export function getHealthStatus(): HealthStatus {
  return { status: "ok" };
}
